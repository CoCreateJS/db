import { join } from 'node:path'
import createIndex from './index/index.js'

const DATABASES = '__distribution_databases__'
const ARRAYS = '__distribution_arrays__'
const KEY = '_id'

/**
 * Create local Cluster availability indexes for entities and regular index partitions.
 * Each mapping stores the available entity or partition path and its holder node ID.
 */
export function createDistributionIndex({ directory, maxBytes, cache = false, nodeId: owner } = {}) {
    const index = createIndex({
        directory,
        maxBytes,
        cache,
        indexDirectoryName: 'distribution',
        resolveArrayDirectory: ({ directory, database, array }) => {
            if (database === DATABASES && array === DATABASES)
                return join(directory, 'databases')
            if (array === ARRAYS)
                return join(directory, 'databases', database, 'arrays')
            return join(directory, 'databases', database, 'arrays', array)
        }
    })

    const partitionIndex = createIndex({
        directory,
        maxBytes,
        cache,
        resolveArrayDirectory: ({ directory }) => join(directory, 'distribution', 'partitions')
    })

    const localized = new Map()
    const localize = (target, database, array, key) => {
        if (!owner) return
        const address = JSON.stringify([database, array, key])
        if (!localized.has(address)) {
            const pending = (async () => {
                const legacy = []
                for await (const entry of target.scan(database, array, key, { type: 'string' }))
                    if (entry.objectId !== 'local') legacy.push(entry)
                for (const entry of legacy) {
                    if (entry.objectId === owner) await target.create(database, array, key, entry.value, 'local')
                    await target.delete(database, array, key, entry.value, entry.objectId)
                }
            })()
            localized.set(address, pending)
            pending.catch(() => localized.delete(address))
        }
        return localized.get(address)
    }

    let queue = Promise.resolve()
    const serialize = operation => {
        const previous = queue
        let release
        queue = new Promise(resolve => { release = resolve })
        return previous.then(operation).finally(release)
    }

    const address = ({ databaseId, arrayId, objectId }) => {
        if (typeof databaseId !== 'string' || !databaseId)
            throw new TypeError('databaseId is required')
        if (objectId !== undefined && (typeof arrayId !== 'string' || !arrayId))
            throw new TypeError('arrayId is required for document availability')

        if (objectId !== undefined) {
            if (typeof objectId !== 'string' || !objectId)
                throw new TypeError('objectId must be a non-empty string')
            return { database: databaseId, array: arrayId, entityId: objectId }
        }
        if (arrayId !== undefined) {
            if (typeof arrayId !== 'string' || !arrayId)
                throw new TypeError('arrayId must be a non-empty string')
            return { database: databaseId, array: ARRAYS, entityId: arrayId }
        }
        return { database: DATABASES, array: DATABASES, entityId: databaseId }
    }

    const get = async ({ databaseId, arrayId, objectId }) => {
        const target = address({ databaseId, arrayId, objectId })
        await localize(index, target.database, target.array, KEY)
        const nodeIds = []

        for await (const entry of index.scan(target.database, target.array, KEY, {
            type: 'string',
            lower: target.entityId,
            upper: target.entityId
        })) {
            if (entry.value === target.entityId && (!owner || entry.objectId === 'local' || entry.objectId === owner)) nodeIds.push(owner ?? entry.objectId)
        }

        return [...new Set(nodeIds)]
    }

    const list = async ({ databaseId, arrayId } = {}) => {
        let target
        if (databaseId === undefined) {
            target = { database: DATABASES, array: DATABASES }
        } else if (arrayId === undefined) {
            target = { database: databaseId, array: ARRAYS }
        } else {
            target = { database: databaseId, array: arrayId }
        }

        await localize(index, target.database, target.array, KEY)
        const entities = new Map()
        for await (const entry of index.scan(target.database, target.array, KEY, { type: 'string' })) {
            if (owner && entry.objectId !== 'local' && entry.objectId !== owner) continue
            if (!entities.has(entry.value)) entities.set(entry.value, new Set())
            entities.get(entry.value).add(owner ?? entry.objectId)
        }
        return [...entities].map(([id, nodeIds]) => ({ id, nodeIds: [...nodeIds] }))
    }

    const getPartition = async partitionId => {
        if (typeof partitionId !== 'string' || !partitionId)
            throw new TypeError('partitionId must be a non-empty string')
        await localize(partitionIndex, '__partitions__', 'index-files', 'partition')
        const nodeIds = []
        for await (const entry of partitionIndex.scan('__partitions__', 'index-files', 'partition', {
            type: 'string', lower: partitionId, upper: partitionId
        })) {
            if (entry.value === partitionId && (!owner || entry.objectId === 'local' || entry.objectId === owner)) nodeIds.push(owner ?? entry.objectId)
        }
        return [...new Set(nodeIds)]
    }

    const listPartitions = async () => {
        await localize(partitionIndex, '__partitions__', 'index-files', 'partition')
        const partitions = new Map()
        for await (const entry of partitionIndex.scan('__partitions__', 'index-files', 'partition', { type: 'string' })) {
            if (owner && entry.objectId !== 'local' && entry.objectId !== owner) continue
            if (!partitions.has(entry.value)) partitions.set(entry.value, new Set())
            partitions.get(entry.value).add(owner ?? entry.objectId)
        }
        return [...partitions].map(([partitionId, nodeIds]) => ({ partitionId, nodeIds: [...nodeIds] }))
    }

    const updatePartition = ({ partitionId, nodeId, operation }) => serialize(async () => {
        if (typeof partitionId !== 'string' || !partitionId)
            throw new TypeError('partitionId must be a non-empty string')
        if (owner && nodeId !== owner) throw new Error('Local distribution can only describe this node')
        if (typeof nodeId !== 'string' || !nodeId)
            throw new TypeError('nodeId must be a non-empty string')
        if (operation !== 'add' && operation !== 'remove')
            throw new TypeError('operation must be add or remove')

        const existing = await getPartition(partitionId)
        const hasNode = existing.includes(nodeId)
        let changed = false
        if (operation === 'add' && (!hasNode || owner)) {
            await partitionIndex.create('__partitions__', 'index-files', 'partition', partitionId, owner ? 'local' : nodeId)
            changed = !hasNode
        } else if (operation === 'remove' && hasNode) {
            changed = await partitionIndex.delete('__partitions__', 'index-files', 'partition', partitionId, owner ? 'local' : nodeId)
            if (owner) changed = await partitionIndex.delete('__partitions__', 'index-files', 'partition', partitionId, owner) || changed
        }
        return { changed, nodeIds: await getPartition(partitionId) }
    })

    const update = ({ databaseId, arrayId, objectId, nodeId, operation }) => serialize(async () => {
        const target = address({ databaseId, arrayId, objectId })
        if (owner && nodeId !== owner) throw new Error('Local distribution can only describe this node')
        if (typeof nodeId !== 'string' || !nodeId)
            throw new TypeError('nodeId must be a non-empty string')
        if (operation !== 'add' && operation !== 'remove')
            throw new TypeError('operation must be add or remove')

        const existing = await get({ databaseId, arrayId, objectId })
        const hasNode = existing.includes(nodeId)
        let changed = false

        if (operation === 'add' && (!hasNode || owner)) {
            await index.create(target.database, target.array, KEY, target.entityId, owner ? 'local' : nodeId)
            changed = !hasNode
        } else if (operation === 'remove' && hasNode) {
            changed = await index.delete(target.database, target.array, KEY, target.entityId, owner ? 'local' : nodeId)
            if (owner) changed = await index.delete(target.database, target.array, KEY, target.entityId, owner) || changed
        }

        return { changed, nodeIds: await get({ databaseId, arrayId, objectId }) }
    })

    return {
        get,
        list,
        update,
        getPartition,
        listPartitions,
        updatePartition,
        clearCache: () => {
            index.clearCache()
            partitionIndex.clearCache()
        }
    }
}

export default createDistributionIndex

/** References use the same stable entity addresses as DB's node distribution. */
export function distributionReferences({ organization_id, storageId, databaseId, arrayId, objectIds = [], type = 'object' }, includeArray = false) {
    const valid = value => typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value)
    if (!valid(organization_id) || !valid(storageId)) return []
    const storage = `${organization_id}/storages/${storageId}`
    if (type === 'storage') return [`${storage}/storage.json`]
    if (!valid(databaseId)) return []
    const database = `${storage}/databases/${databaseId}`
    if (type === 'database') return [`${database}/database.json`]
    if (!valid(arrayId)) return [`${database}/arrays/index/index.json`]
    const array = `${database}/arrays/${arrayId}`
    if (type === 'array') return [`${array}/array.json`, `${database}/arrays/index/index.json`]
    const references = objectIds.filter(valid).map(id => `${array}/objects/${id}.json`)
    if (includeArray || !objectIds.length) references.push(`${array}/array.json`)
    return [...new Set(references)]
}
