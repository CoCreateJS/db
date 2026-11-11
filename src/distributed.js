import { join } from 'node:path'
import createIndex from './index/index.js'

const DATABASES = '__distributed_databases__'
const ARRAYS = '__distributed_arrays__'
const KEY = '_id'

/**
 * Create local Cluster availability indexes for entities and regular index partitions.
 * Each mapping stores the available entity or partition path and its holder node ID.
 */
export function createDistributedIndex({ directory, maxBytes, cache = false } = {}) {
    const index = createIndex({
        directory,
        maxBytes,
        cache,
        indexDirectoryName: 'distributed',
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
        resolveArrayDirectory: ({ directory }) => join(directory, 'distributed', 'partitions')
    })

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
        const nodeIds = []

        for await (const entry of index.scan(target.database, target.array, KEY, {
            type: 'string',
            lower: target.entityId,
            upper: target.entityId
        })) {
            if (entry.value === target.entityId) nodeIds.push(entry.objectId)
        }

        return nodeIds
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

        const entities = new Map()
        for await (const entry of index.scan(target.database, target.array, KEY, { type: 'string' })) {
            if (!entities.has(entry.value)) entities.set(entry.value, new Set())
            entities.get(entry.value).add(entry.objectId)
        }
        return [...entities].map(([id, nodeIds]) => ({ id, nodeIds: [...nodeIds] }))
    }

    const getPartition = async partitionId => {
        if (typeof partitionId !== 'string' || !partitionId)
            throw new TypeError('partitionId must be a non-empty string')
        const nodeIds = []
        for await (const entry of partitionIndex.scan('__partitions__', 'index-files', 'partition', {
            type: 'string', lower: partitionId, upper: partitionId
        })) {
            if (entry.value === partitionId) nodeIds.push(entry.objectId)
        }
        return nodeIds
    }

    const listPartitions = async () => {
        const partitions = new Map()
        for await (const entry of partitionIndex.scan('__partitions__', 'index-files', 'partition', { type: 'string' })) {
            if (!partitions.has(entry.value)) partitions.set(entry.value, new Set())
            partitions.get(entry.value).add(entry.objectId)
        }
        return [...partitions].map(([partitionId, nodeIds]) => ({ partitionId, nodeIds: [...nodeIds] }))
    }

    const updatePartition = ({ partitionId, nodeId, operation }) => serialize(async () => {
        if (typeof partitionId !== 'string' || !partitionId)
            throw new TypeError('partitionId must be a non-empty string')
        if (typeof nodeId !== 'string' || !nodeId)
            throw new TypeError('nodeId must be a non-empty string')
        if (operation !== 'add' && operation !== 'remove')
            throw new TypeError('operation must be add or remove')

        const existing = await getPartition(partitionId)
        const hasNode = existing.includes(nodeId)
        let changed = false
        if (operation === 'add' && !hasNode) {
            await partitionIndex.set('__partitions__', 'index-files', 'partition', partitionId, nodeId)
            changed = true
        } else if (operation === 'remove' && hasNode) {
            changed = await partitionIndex.remove('__partitions__', 'index-files', 'partition', partitionId, nodeId)
        }
        return { changed, nodeIds: await getPartition(partitionId) }
    })

    const update = ({ databaseId, arrayId, objectId, nodeId, operation }) => serialize(async () => {
        const target = address({ databaseId, arrayId, objectId })
        if (typeof nodeId !== 'string' || !nodeId)
            throw new TypeError('nodeId must be a non-empty string')
        if (operation !== 'add' && operation !== 'remove')
            throw new TypeError('operation must be add or remove')

        const existing = await get({ databaseId, arrayId, objectId })
        const hasNode = existing.includes(nodeId)
        let changed = false

        if (operation === 'add' && !hasNode) {
            await index.set(target.database, target.array, KEY, target.entityId, nodeId)
            changed = true
        } else if (operation === 'remove' && hasNode) {
            changed = await index.remove(target.database, target.array, KEY, target.entityId, nodeId)
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

export default createDistributedIndex
