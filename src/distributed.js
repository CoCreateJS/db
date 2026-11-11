import { join } from 'node:path'
import createIndex from './index/index.js'

const DATABASES = '__distributed_databases__'
const ARRAYS = '__distributed_arrays__'
const KEY = '_id'

/**
 * Create the local Cluster availability indexes beside the ordinary indexes.
 * A value is an entity ID and its index objectId is the Cluster node ID.
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
        update,
        clearCache: () => index.clearCache()
    }
}

export default createDistributedIndex
