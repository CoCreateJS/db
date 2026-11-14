import { join, resolve } from 'node:path'
import { rm } from '../io.js'
import { createUpdate, ObjectId, queryData } from '@cocreate/utils'
import { adjustArrayLength, ensureArray, materializeArray, sendArray } from '../array/index.js'
import { adjustDatabaseLengths, ensureDatabase, materializeDatabase, sendDatabase } from '../database/index.js'
import createIndex from '../index/index.js'
import { createPeerDistribution, mergeDistributionLists } from '../peers.js'
import indexCRUD from '../index/crud.js'
import { createDistributionIndex } from '../distribution.js'
import {
    ARRAY_CATALOG, DATABASE_CATALOG, DATABASE_CATALOG_ARRAY,
    arrayDirectory, arrayMetadataPath, auditMetadata, databaseDirectory, databaseMetadataPath,
    normalizeObject, objectPath, objectDeletionPath, readJSON, replaceJSON, writeExclusiveJSON, setPath, typeOf, flattenIndexValues
} from '../storage.js'
import { hasQueryConditions, normalizeQuery, queryIndexCandidates } from '../query.js'
import { applyReadFilter } from '../read.js'
import { createRecord, deleteRecord, findRecordByName, readRecordById, readRecords, reconcileEntrySets } from '../records.js'
import { indexEntries, entryKey } from '../entries.js'
import { prepareMutation, live } from '../mutation.js'
import { createPersistence } from '../persistence.js'
import { enableMemoryCache, memoryStats, removeMemoryPath } from '../memory.js'

function errorHandler(data, error) {
    if (!Array.isArray(data.error)) data.error = data.error === undefined ? [] : [data.error]
    const errors = error?.errors ?? error?.message ?? error
    data.error.push(...(Array.isArray(errors) ? errors : [errors]))
    data.success = false
    return data
}

const isObjectId = value => typeof value === 'string' && /^[0-9a-f]{24}$/i.test(value)

function tagRecord(record, request) {
    record = live(record)
    record.$storage ??= ['db']
    record.$database ??= [request.database ?? request.organization_id]
    record.$array ??= [request.array]
    return record
}

// Preserve the request's update syntax and operands; do not diff the final record.
function createUpdatePatch(input, request) {
    if (Object.hasOwn(input, '$update')) return input.$update
    if (Object.hasOwn(request, '$update')) return request.$update
    const patch = {}, removed = {}
    for (const [operator, values] of Object.entries(request)) {
        if (!operator.startsWith('$') || !values || typeof values !== 'object') continue
        for (const [path, value] of Object.entries(values)) patch[`${operator}.${path}`] = value
    }
    for (const [key, value] of Object.entries(input)) {
        if (['_id', 'filter', '$storage', '$database', '$array'].includes(key)) continue
        if (value === undefined && !key.startsWith('$')) removed[key] = true
        else patch[key] = value
    }
    if (Object.keys(removed).length) patch.$unset = { ...removed, ...patch.$unset }
    return patch
}

function applyObjectUpdate(current, patch, audit) {
    const plan = prepareMutation(current)
    const updated = plan.value
    if (createUpdate(updated, patch) === false)
        throw new Error('Shared update utility could not apply the requested update')
    if (updated._id !== current._id) throw new Error('object._id cannot be changed')
    if (updated.created?.on !== current.created?.on)
        throw new Error('object.created.on cannot be changed')
    if (audit) setPath(updated, 'updated', audit)
    return plan
}

// Delivery views do not attach transport metadata to the persisted document.
function updateReply(record, patch) {
    return { ...record, $update: patch }
}
const peerUpdate = (record, patch) => ({ _id: record._id, $update: patch, updated: record.updated })

/**
 * Create a filesystem-backed CoCreateDB instance.
 * The configured directory contains database/array index files and object JSON files.
 */
export function createDB({
    directory = './storage', maxIndexBytes = 128 * 1024, cache = false, memoryCache = false,
    nodeId, distributionAdapter, peerReader, partitionAdapter, documentMutationAdapter,
    writeBehind = false, memoryOnly = false, disk = true, sharedPersistence, scheduleIndexing = operation => operation(), onIndexed, persistenceOptions = {}
} = {}) {
    const root = resolve(directory)
    const peers = createPeerDistribution(nodeId)
    distributionAdapter ??= {
        update: (payload, apply) => !nodeId || payload.nodeId === nodeId ? apply(payload) : peers.update(payload),
        get: async (payload, read) => [...new Set([...await read(payload), ...peers.get(payload)])].sort(),
        list: async (payload, read) => mergeDistributionLists(await read(payload), peers.list(payload))
    }
    partitionAdapter ??= {
        update: (payload, apply) => !nodeId || payload.nodeId === nodeId ? apply(payload) : peers.updatePartition(payload),
        get: async (path, read) => [...new Set([...await read(path), ...peers.getPartition(path)])].sort(),
        list: async read => mergeDistributionLists(await read(), peers.listPartitions(), 'partitionId')
    }
    if (memoryCache || memoryOnly || disk === false) enableMemoryCache(root, { memoryOnly: memoryOnly || disk === false })
    const deferred = writeBehind || memoryOnly || disk === false
    const deletedObjects = new Map()
    const getDeletion = async (database, array, id) => {
        const path = objectDeletionPath(root, database, array, id)
        if (!deletedObjects.has(path)) deletedObjects.set(path, await readJSON(path))
        return deletedObjects.get(path)
    }
    const markDeleted = async (database, array, object) => {
        const path = objectDeletionPath(root, database, array, object._id)
        const marker = { _id: object._id, created: { on: object.created?.on }, deleted: { on: new Date().toISOString() } }
        await replaceJSON(path, marker)
        deletedObjects.set(path, marker)
    }
    const clearDeletion = async (database, array, id) => {
        const path = objectDeletionPath(root, database, array, id)
        if (await getDeletion(database, array, id)) await rm(path, { force: true })
        deletedObjects.set(path, undefined)
    }
    const staleGeneration = (incoming, marker) => marker &&
        (!incoming.created?.on || !marker.created?.on || incoming.created.on <= marker.created.on)
    const pendingIndexes = new Map()
    const documentRevisions = new Map()
    let indexTimer, indexScheduled = false, indexError, closing = false
    const persistence = memoryOnly || disk === false ? undefined : sharedPersistence ?? (writeBehind ? createPersistence({
        ...persistenceOptions, directory: root, canFlush: () => pendingIndexes.size === 0
    }) : undefined)
    const requestIndexing = (delay = 0) => {
        if (indexScheduled || closing || !pendingIndexes.size) return
        indexScheduled = true
        indexTimer = setTimeout(() => {
            indexTimer = undefined
            Promise.resolve().then(() => scheduleIndexing(processPendingIndexes)).catch(error => {
                indexError = error
            }).finally(() => {
                indexScheduled = false
                if (pendingIndexes.size && !indexError) requestIndexing()
                else if (!pendingIndexes.size) persistence?.schedule()
            })
        }, delay)
        indexTimer.unref?.()
    }
    const queueIndex = (database, array, before, objectId, publish = true, createdOn, update) => {
        const path = objectPath(root, database, array, objectId)
        let entry = pendingIndexes.get(path)
        if (!entry) {
            entry = { database, array, objectId, indexed: before ?? [], createdOn, revision: 0, publish, holders: new Set(), updates: [] }
            pendingIndexes.set(path, entry)
        }
        entry.revision = (documentRevisions.get(path) ?? 0) + 1
        documentRevisions.set(path, entry.revision)
        entry.publish ||= publish
        if (update) entry.updates.push(update)
        requestIndexing()
    }
    const processPendingIndexes = async () => {
        const release = persistence?.hold()
        try {
            for (const [path, entry] of pendingIndexes) {
                const revision = entry.revision
                const indexedBefore = entry.indexed
                try {
                    const latest = await readJSON(path)
                    const after = indexEntries(latest)
                    for (const holder of await captureEntryHolders(entry.database, entry.array, entry.indexed, entry.objectId)) entry.holders.add(holder)
                    await reconcileEntrySets(storageIndex, entry.database, entry.array, entry.objectId, entry.indexed, after)
                    entry.indexed = after
                    if (latest)
                        for (const holder of await captureObjectHolders(entry.database, entry.array, latest)) entry.holders.add(holder)
                    const operation = !latest ? 'remove' : entry.createdOn && entry.createdOn === latest.created?.on ? 'update' : 'set'
                    const updates = entry.updates.slice()
                    if (operation === 'update') {
                        // Index reconciliation can coalesce; incremental operations cannot.
                        for (const update of updates) {
                            if (entry.publish) await publishObjectMutation(operation, entry.database, entry.array, update, entry.holders, latest.created?.on)
                            await onIndexed?.({ databaseId: entry.database, arrayId: entry.array, objectId: entry.objectId,
                                revision, operation, object: updateReply(latest, update.$update) })
                        }
                    } else {
                        const object = latest ?? entry.removed
                        if (entry.publish && object)
                            await publishObjectMutation(operation, entry.database, entry.array, object, entry.holders, latest?.created?.on)
                        await onIndexed?.({ databaseId: entry.database, arrayId: entry.array, objectId: entry.objectId, revision, operation, object: live(object) })
                    }
                    entry.updates.splice(0, updates.length)
                    if (entry.revision === revision) pendingIndexes.delete(path)
                } catch (error) {
                    indexError = error
                    storageIndex.clearCache()
                    distributionIndex.clearCache()
                    entry.indexed = indexedBefore
                    throw error
                }
            }
            indexError = undefined
        } finally { release?.() }
    }
    const flushIndexes = async () => {
        if (indexTimer) { clearTimeout(indexTimer); indexTimer = undefined; indexScheduled = false }
        await processPendingIndexes()
    }
    const flush = async () => { await flushIndexes(); await persistence?.flush() }
    const ready = Promise.resolve({ files: 0 })
    const storageIndex = createIndex({
        directory: root,
        maxBytes: maxIndexBytes,
        cache,
        resolveArrayDirectory: ({ directory, database, array }) => {
            if (database === DATABASE_CATALOG && array === DATABASE_CATALOG_ARRAY)
                return join(directory, 'databases')
            if (array === ARRAY_CATALOG)
                return join(databaseDirectory(directory, database), 'arrays')
            return arrayDirectory(directory, database, array)
        },
        readPartition: path => partitionAdapter?.read?.(path),
        onPartitionChange: change => {
            if (!nodeId) return
            const payload = { ...change, nodeId }
            return partitionAdapter?.onLocalChange
                ? partitionAdapter.onLocalChange(payload, updateLocalPartition)
                : updateLocalPartition({
                    partitionId: change.path,
                    nodeId,
                    operation: change.operation === 'remove' ? 'remove' : 'add'
                })
        }
    })
    const distributionIndex = createDistributionIndex({
        directory: root,
        nodeId,
        maxBytes: maxIndexBytes,
        cache
    })

    const resolveDistributionIds = async ({ database, databaseId, array, arrayId, objectId }) => {
        if (!databaseId && database) {
            const databaseRecord = await findRecordByName(
                storageIndex, DATABASE_CATALOG, DATABASE_CATALOG_ARRAY,
                id => databaseMetadataPath(root, id), database
            )
            databaseId = databaseRecord?._id ?? database
        }
        if (!arrayId && array && databaseId) {
            const arrayRecord = await findRecordByName(
                storageIndex, databaseId, ARRAY_CATALOG,
                id => arrayMetadataPath(root, databaseId, id), array
            )
            arrayId = arrayRecord?._id ?? array
        }
        return { databaseId, arrayId, objectId }
    }

    const updateLocalDistribution = payload => distributionIndex.update(payload)
    const getLocalDistribution = payload => distributionIndex.get(payload)
    const listLocalDistribution = payload => distributionIndex.list(payload)
    const updateLocalPartition = payload => distributionIndex.updatePartition(payload)
    const getLocalPartition = partitionId => distributionIndex.getPartition(partitionId)
    const listLocalPartitions = () => distributionIndex.listPartitions()

    const updateDistribution = async request => {
        const ids = await resolveDistributionIds(request)
        const payload = { ...ids, nodeId: request.nodeId, operation: request.operation }
        return distributionAdapter?.update
            ? distributionAdapter.update(payload, updateLocalDistribution)
            : updateLocalDistribution(payload)
    }

    const getDistribution = async request => {
        const ids = await resolveDistributionIds(request)
        return distributionAdapter?.get
            ? distributionAdapter.get(ids, getLocalDistribution)
            : getLocalDistribution(ids)
    }

    const listDistribution = async request => distributionAdapter?.list
        ? distributionAdapter.list(request, listLocalDistribution)
        : listLocalDistribution(request)

    const updatePartition = payload => partitionAdapter?.update
        ? partitionAdapter.update(payload, updateLocalPartition)
        : updateLocalPartition(payload)

    const getPartitionHolders = partitionId => partitionAdapter?.get
        ? partitionAdapter.get(partitionId, getLocalPartition)
        : getLocalPartition(partitionId)

    const listPartitions = () => partitionAdapter?.list
        ? partitionAdapter.list(listLocalPartitions)
        : listLocalPartitions()

    const markLocalPartition = async ({ path, operation, value, acquired = false, replicated = false }) => {
        if (!nodeId) return
        const payload = { partitionId: path, nodeId, operation: operation === 'remove' ? 'remove' : 'add' }
        if (partitionAdapter?.onLocalChange)
            return partitionAdapter.onLocalChange({ ...payload, path, operation, value, acquired, replicated }, updateLocalPartition)
        return updateLocalPartition(payload)
    }

    const applyIndexPartition = async (path, value, { replicated = false } = {}) => {
        const node = await storageIndex.applyPartition(path, value)
        await markLocalPartition({ path, operation: 'set', value: node, acquired: !replicated, replicated })
        return node
    }

    const removeIndexPartition = async (path, { replicated = false } = {}) => {
        await storageIndex.removePartition(path)
        await markLocalPartition({ path, operation: 'remove', acquired: !replicated, replicated })
    }

    const markLocalAvailability = async (ids, operation) => {
        if (!nodeId) return
        const payload = { ...ids, nodeId, operation }
        if (distributionAdapter?.onLocalChange)
            return distributionAdapter.onLocalChange(payload, updateLocalDistribution)
        return updateLocalDistribution(payload)
    }

    const localObjectIds = async (databaseId, arrayId) => {
        const ids = []
        for await (const entry of storageIndex.scan(databaseId, arrayId, '_id', { type: 'string' }))
            ids.push(entry.value)
        return ids
    }

    const captureObjectHolders = async (database, array, object) => {
        const holders = new Set()
        if (!documentMutationAdapter?.publish) return holders
        const entries = flattenIndexValues(object).filter(([key]) => key !== '_id')
        const paths = await storageIndex.locatePartitions(database, array, entries, object._id)
        for (const path of paths)
            for (const holder of await getPartitionHolders(path)) holders.add(holder)
        return holders
    }

    const captureEntryHolders = async (database, array, entries, objectId) => {
        const holders = new Set()
        if (!documentMutationAdapter?.publish) return holders
        for (const path of await storageIndex.locateIndexedPartitions(database, array, entries, objectId))
            for (const holder of await getPartitionHolders(path)) holders.add(holder)
        return holders
    }

    const publishObjectMutation = async (operation, databaseId, arrayId, object, holders, createdOn) => {
        if (!documentMutationAdapter?.publish || !holders.size) return
        await documentMutationAdapter.publish({
            operation,
            databaseId,
            arrayId,
            object: live(object),
            ...(createdOn ? { createdOn } : {}),
            database: live(await readJSON(databaseMetadataPath(root, databaseId))),
            array: live(await readJSON(arrayMetadataPath(root, databaseId, arrayId))),
            targets: [...holders].filter(id => id !== nodeId)
        })
    }

    const prepareAvailabilityRemoval = async entities => {
        const changed = []
        try {
            for (const entity of entities) {
                const result = await markLocalAvailability(entity, 'remove')
                if (result?.changed) changed.push(entity)
            }
            return changed
        } catch (error) {
            for (const entity of changed.reverse())
                await markLocalAvailability(entity, 'add').catch(() => {})
            throw error
        }
    }

    const restoreAvailability = async entities => {
        for (const entity of entities)
            await markLocalAvailability(entity, 'add')
    }

    const createObjects = async (request, database, array, { publishMutation = true } = {}) => {
        const values = request.object === undefined
            ? []
            : Array.isArray(request.object) ? request.object : [request.object]
        const created = []

        for (const input of values) {
            if (!input || typeof input !== 'object' || Array.isArray(input))
                throw new TypeError('object.create expects an object or an array of objects')

            const object = normalizeObject(input)
            const objectId = object._id ?? ObjectId().toString()

            if (typeof objectId !== 'string' || !/^[0-9a-fA-F]{24}$/.test(objectId))
                throw new TypeError('object._id must be a 24-character hexadecimal ObjectId')

            object._id = objectId.toLowerCase()
            if (request.organization_id && !Object.hasOwn(object, 'organization_id'))
                object.organization_id = request.organization_id

            const audit = auditMetadata(request)
            const deletion = await getDeletion(database, array, object._id)
            if (deletion) {
                const previous = Date.parse(deletion.created?.on)
                object.created = { ...audit, on: new Date(Math.max(Date.now(), Number.isFinite(previous) ? previous + 1 : 0)).toISOString() }
            }
            object.created ??= { ...audit }
            object.updated ??= { ...audit }

            const file = objectPath(root, database, array, object._id)
            let wroteObject = false
            let arrayLengthUpdated = false
            let databaseLengthUpdated = false

            try {
                if (deferred) await writeExclusiveJSON(file, object)
                else await createRecord(storageIndex, database, array, file, object)
                wroteObject = true
                await clearDeletion(database, array, object._id)
                await adjustArrayLength(root, storageIndex, database, array, 1, request)
                arrayLengthUpdated = true
                await adjustDatabaseLengths(root, storageIndex, database, { objects: 1 }, request)
                databaseLengthUpdated = true
            } catch (error) {
                if (databaseLengthUpdated)
                    await adjustDatabaseLengths(root, storageIndex, database, { objects: -1 }, request).catch(() => {})
                if (arrayLengthUpdated)
                    await adjustArrayLength(root, storageIndex, database, array, -1, request).catch(() => {})
                if (wroteObject)
                    await deleteRecord(storageIndex, database, array, file, object).catch(() => {})
                if (deletion) {
                    await replaceJSON(objectDeletionPath(root, database, array, object._id), deletion)
                    deletedObjects.set(objectDeletionPath(root, database, array, object._id), deletion)
                }
                throw error
            }

            created.push(tagRecord(object, request))
            if (deferred) queueIndex(database, array, undefined, object._id, publishMutation)
            else if (publishMutation) {
                const holders = await captureObjectHolders(database, array, object)
                await publishObjectMutation('set', database, array, object, holders)
            }
        }

        return created
    }

    const readLocalObject = async (database, array, objectId) => {
        const file = objectPath(root, database, array, objectId)
        return readRecordById(storageIndex, database, array, () => file, objectId)
    }

    const hydrateObjects = async (request, records) => {
        if (!Array.isArray(records)) throw new TypeError('Persistence hydration requires complete objects')
        for (const record of records) {
            if (!record || !isObjectId(record._id)) throw new TypeError('Hydrated objects require an ObjectId')
            if (record.organization_id && String(record.organization_id) !== request.organization_id)
                throw new Error('Hydrated object belongs to a different organization')
        }
        if (!records.length) return
        const database = await ensureDatabase(root, storageIndex, request.database, {}, request)
        const array = await ensureArray(root, storageIndex, database, request.array, {}, request)
        for (const record of records) {
            record._id = record._id.toLowerCase()
            for (const key of ['created', 'updated'])
                if (record[key]?.on instanceof Date) record[key].on = record[key].on.toISOString()
            // A stale provider response cannot overwrite local state or resurrect
            // a deleted lifetime. Acquisition is not a new create notification.
            if (await readLocalObject(database._id, array._id, record._id) ||
                await getDeletion(database._id, array._id, record._id)) continue
            await createObjects({ ...request, method: 'object.create', object: record }, database._id, array._id,
                { publishMutation: false })
            await markLocalAvailability({ databaseId: database._id }, 'add')
            await markLocalAvailability({ databaseId: database._id, arrayId: array._id }, 'add')
            await markLocalAvailability({ databaseId: database._id, arrayId: array._id, objectId: record._id }, 'add')
        }
        // Install the index revision now; the normal local disk queue follows it.
        await flushIndexes()
    }

    const readLocalEntity = async ({ type, databaseId, arrayId, objectId }) => {
        let file
        let id
        if (type === 'database') {
            file = databaseMetadataPath(root, databaseId)
            id = databaseId
        } else if (type === 'array') {
            file = arrayMetadataPath(root, databaseId, arrayId)
            id = arrayId
        } else if (type === 'object') {
            file = objectPath(root, databaseId, arrayId, objectId)
            id = objectId
        } else {
            throw new TypeError('Peer fetch type must be database, array, or object')
        }
        const record = await readJSON(file)
        return record?._id === id ? record : undefined
    }

    const applyReplicatedObjectMutation = async ({ operation, database, array, object, createdOn, serverId, upsert = false }) => {
        if (!['set', 'update', 'remove'].includes(operation) || !object || !isObjectId(object._id))
            throw new TypeError('Invalid replicated object mutation')
        const databaseId = database?._id
        const arrayId = array?._id
        if (!isObjectId(databaseId) || !isObjectId(arrayId) || database._id !== databaseId || array._id !== arrayId)
            throw new TypeError('Replicated object mutation requires database and array metadata')

        let current = await readLocalObject(databaseId, arrayId, object._id)
        const deletion = await getDeletion(databaseId, arrayId, object._id)
        if (operation === 'update') {
            if (deletion || (createdOn && current?.created?.on && createdOn !== current.created.on)) return false
            if (current) {
                const plan = applyObjectUpdate(current, object.$update, object.updated)
                plan.commit()
            } else {
                if (!peerReader || !serverId) throw new Error(`Cannot apply an update without the base object: ${object._id}`)
                // The publishing node's snapshot already includes this operation.
                current = await peerReader({ nodeId: serverId, type: 'object', databaseId, arrayId, objectId: object._id })
                if (!current || current._id !== object._id || (createdOn && current.created?.on !== createdOn)) return false
            }
        }
        if (operation === 'set' && !upsert && (staleGeneration(object, deletion) ||
            (current?.created?.on && object.created?.on && object.created.on < current.created.on))) return false
        if (operation === 'remove' && !current && staleGeneration(object, deletion)) return false
        if (operation === 'remove' && current?.created?.on && object.created?.on && current.created.on !== object.created.on) return false
        await replaceJSON(databaseMetadataPath(root, databaseId), database)
        await replaceJSON(arrayMetadataPath(root, databaseId, arrayId), array)
        const file = objectPath(root, databaseId, arrayId, object._id)
        if (operation === 'remove') {
            await markDeleted(databaseId, arrayId, object)
            removeMemoryPath(file)
            await rm(file, { force: true })
        }
        else {
            await replaceJSON(file, operation === 'update' ? current : object)
            await clearDeletion(databaseId, arrayId, object._id)
        }

        await markLocalAvailability({ databaseId }, 'add')
        await markLocalAvailability({ databaseId, arrayId }, 'add')
        await markLocalAvailability({ databaseId, arrayId, objectId: object._id }, operation === 'remove' ? 'remove' : 'add')
        return true
    }

    const acquireEntity = async (type, databaseId, arrayId, objectId) => {
        if (!peerReader) return undefined
        const refs = type === 'database'
            ? await getDistribution({ databaseId })
            : type === 'array'
                ? await getDistribution({ databaseId, arrayId })
                : await getDistribution({ databaseId, arrayId, objectId })

        for (const remoteNodeId of refs) {
            if (remoteNodeId === nodeId) continue
            try {
                const record = await peerReader({
                    nodeId: remoteNodeId,
                    type,
                    databaseId,
                    arrayId,
                    objectId
                })
                if (record?._id === (type === 'database' ? databaseId : type === 'array' ? arrayId : objectId))
                    return record
            } catch { /* Try the next available holder. */ }
        }
        return undefined
    }

    const materializeDatabaseFromPeer = async (databaseId, source) => {
        const record = source ?? await acquireEntity('database', databaseId)
        if (!record) return undefined
        const database = await materializeDatabase(root, storageIndex, record)
        await markLocalAvailability({ databaseId }, 'add')
        return database
    }

    const materializeArrayFromPeer = async (database, arrayId, source) => {
        const record = source ?? await acquireEntity('array', database._id, arrayId)
        if (!record) return undefined
        const array = await materializeArray(root, storageIndex, database, record)
        await markLocalAvailability({ databaseId: database._id }, 'add')
        await markLocalAvailability({ databaseId: database._id, arrayId }, 'add')
        return array
    }

    const resolveDatabaseFromPeers = async name => {
        for (const { id, nodeIds } of await listDistribution()) {
            if (!isObjectId(id)) continue
            if (await readJSON(databaseMetadataPath(root, id))) continue
            for (const remoteNodeId of nodeIds) {
                if (remoteNodeId === nodeId || !peerReader) continue
                try {
                    const record = await peerReader({ nodeId: remoteNodeId, type: 'database', databaseId: id })
                    if (record?.name !== name || record?._id !== id) continue
                    return await materializeDatabaseFromPeer(id, record)
                } catch { /* Try another holder for this database ID. */ }
            }
        }
        return undefined
    }

    const resolveArrayFromPeers = async (database, name) => {
        for (const { id, nodeIds } of await listDistribution({ databaseId: database._id })) {
            if (!isObjectId(id)) continue
            if (await readJSON(arrayMetadataPath(root, database._id, id))) continue
            for (const remoteNodeId of nodeIds) {
                if (remoteNodeId === nodeId || !peerReader) continue
                try {
                    const record = await peerReader({
                        nodeId: remoteNodeId,
                        type: 'array',
                        databaseId: database._id,
                        arrayId: id
                    })
                    if (record?.name !== name || record?._id !== id) continue
                    return await materializeArrayFromPeer(database, id, record)
                } catch { /* Try another holder for this array ID. */ }
            }
        }
        return undefined
    }

    const resolveAllDatabasesFromPeers = async () => {
        for (const { id } of await listDistribution())
            if (isObjectId(id) && !(await readJSON(databaseMetadataPath(root, id))))
                await materializeDatabaseFromPeer(id)
    }

    const resolveAllArraysFromPeers = async database => {
        for (const { id } of await listDistribution({ databaseId: database._id }))
            if (isObjectId(id) && !(await readJSON(arrayMetadataPath(root, database._id, id))))
                await materializeArrayFromPeer(database, id)
    }

    const acquisitionPromises = new Map()
    const materializeObjectFromPeer = async (databaseId, arrayId, objectId, request = {}) => {
        const key = `${databaseId}/${arrayId}/${objectId}`
        if (acquisitionPromises.has(key)) return acquisitionPromises.get(key)
        const promise = (async () => {
            const existing = await readLocalObject(databaseId, arrayId, objectId)
            if (existing) return existing
            const record = await acquireEntity('object', databaseId, arrayId, objectId)
            if (!record || staleGeneration(record, await getDeletion(databaseId, arrayId, objectId))) return undefined

            try {
                await createObjects({
                    ...request,
                    method: 'object.create',
                    database: request.database,
                    array: request.array,
                    object: record
                }, databaseId, arrayId, { publishMutation: false })
            } catch (error) {
                const concurrent = await readLocalObject(databaseId, arrayId, objectId)
                if (!concurrent) throw error
            }

            await markLocalAvailability({ databaseId }, 'add')
            await markLocalAvailability({ databaseId, arrayId }, 'add')
            await markLocalAvailability({ databaseId, arrayId, objectId }, 'add')
            return readLocalObject(databaseId, arrayId, objectId)
        })()
        acquisitionPromises.set(key, promise)
        try {
            return await promise
        } finally {
            acquisitionPromises.delete(key)
        }
    }

    const loadObject = async (database, array, objectId, request = {}) => {
        const object = await readLocalObject(database, array, objectId)
        if (object) return object
        if (pendingIndexes.has(objectPath(root, database, array, objectId)))
            throw new Error(`Object file not found: ${objectId}`)
        const acquired = await materializeObjectFromPeer(database, array, objectId, request)
        if (acquired) return acquired
        throw new Error(`Object file not found: ${objectId}`)
    }

    const selectObjects = async (database, array, query, request = {}) => {
        const hydrated = new Map()
        const readForPlanning = async objectId => {
            if (hydrated.has(objectId)) return hydrated.get(objectId)
            const object = pendingIndexes.has(objectPath(root, database, array, objectId))
                ? await readLocalObject(database, array, objectId)
                : await loadObject(database, array, objectId, request)
            hydrated.set(objectId, object)
            return object
        }
        const { ids } = await queryIndexCandidates(storageIndex, database, array, query, {
            readObject: readForPlanning
        })
        const objects = []

        const candidates = new Set(ids)
        for (const entry of pendingIndexes.values())
            if (entry.database === database && entry.array === array) candidates.add(entry.objectId)
        for (const objectId of candidates) {
            const path = objectPath(root, database, array, objectId)
            const pending = pendingIndexes.has(path)
            if (pending && !(await readJSON(path))) continue
            const object = pending ? await readJSON(path) : hydrated.get(objectId) ?? await loadObject(database, array, objectId, request)
            if (queryData(object, query)) objects.push(object)
        }

        return objects
    }

    const readObjects = async (request, database, array) => {
        const query = normalizeQuery(request)
        const requestedId = query._id
        const requestedIds = typeof requestedId === 'string'
            ? [requestedId]
            : requestedId && typeof requestedId === 'object' && !Array.isArray(requestedId)
                ? requestedId.$eq ? [requestedId.$eq]
                    : Array.isArray(requestedId.$in) ? requestedId.$in : []
                : []
        for (const objectId of requestedIds)
            if (typeof objectId === 'string' && /^[0-9a-f]{24}$/i.test(objectId))
                if (!pendingIndexes.has(objectPath(root, database, array, objectId.toLowerCase())))
                    await materializeObjectFromPeer(database, array, objectId.toLowerCase(), request)

        const objects = await selectObjects(database, array, query, request)
        return applyReadFilter(objects, request, {
            database: request.database ?? request.organization_id,
            array: request.array,
            query
        }).map(object => tagRecord(object, request))
    }

    const updateObjects = async (request, database, array) => {
        const inputs = request.object === undefined
            ? Object.hasOwn(request, '$update') ? [{}] : []
            : Array.isArray(request.object) ? request.object : [request.object]

        if (!inputs.length)
            throw new Error('object.update requires object data')

        const createFromUpdate = async input => {
            const patch = createUpdatePatch(input, request)
            const record = input._id === undefined ? {} : { _id: input._id }
            if (createUpdate(record, patch) === false)
                throw new Error('Shared update utility could not apply the requested update')
            const records = await createObjects({ ...request, method: 'object.create', object: record }, database, array)
            return records.map(record => updateReply(record, patch))
        }
        const identified = inputs.filter(input => input && typeof input === 'object' && input._id)
        const targets = []

        if (identified.length) {
            if (identified.length !== inputs.length)
                throw new Error('Each object in a multi-object update must include _id')

            for (const input of identified) {
                const objectId = String(input._id).toLowerCase()
                const deletion = await getDeletion(database, array, objectId)
                const current = deletion ? undefined : await readLocalObject(database, array, objectId) ??
                    await materializeObjectFromPeer(database, array, objectId, request)

                if (!current) {
                    if (request.upsert && inputs.length === 1)
                        return createFromUpdate(input)

                    throw new Error(`Object file not found: ${objectId}`)
                }

                targets.push({ current, input })
            }
        } else {
            if (!request.filter?.query)
                throw new Error('object.update requires object._id or filter.query')
            if (inputs.length !== 1)
                throw new Error('A filtered update accepts one update object')

            const query = normalizeQuery(request)
            const currentObjects = await selectObjects(database, array, query, request)
            for (const current of currentObjects)
                targets.push({ current, input: inputs[0] })
        }

        if (!targets.length && request.upsert) {
            if (inputs.length !== 1)
                throw new Error('An upsert accepts one object')
            return createFromUpdate(inputs[0])
        }

        const updatedObjects = []

        for (const { current, input } of targets) {
            const before = indexEntries(current)
            const createdOn = current.created?.on
            const patch = createUpdatePatch(input, request)
            const mutation = applyObjectUpdate(current, patch, auditMetadata(request))
            mutation.commit()
            const updated = live(current)
            const after = indexEntries(updated)
            const beforeKeys = new Set(before.map(entryKey)), afterKeys = new Set(after.map(entryKey))
            const changedKeys = new Set()
            for (const entry of before) if (!afterKeys.has(entryKey(entry))) changedKeys.add(entry.key)
            for (const entry of after) if (!beforeKeys.has(entryKey(entry))) changedKeys.add(entry.key)
            if (changedKeys.size) {
                if (deferred) {
                    await replaceJSON(objectPath(root, database, array, current._id), updated)
                    queueIndex(database, array, before, current._id, true, createdOn, peerUpdate(updated, patch))
                } else {
                    const holders = await captureEntryHolders(database, array, before, current._id)
                    await reconcileEntrySets(storageIndex, database, array, current._id, before, after)
                    await replaceJSON(objectPath(root, database, array, current._id), updated)
                    for (const holder of await captureObjectHolders(database, array, updated)) holders.add(holder)
                    await publishObjectMutation('update', database, array, peerUpdate(updated, patch), holders, updated.created?.on)
                }
            }
            updatedObjects.push(updateReply(tagRecord(updated, request), patch))
        }

        return updatedObjects
    }

    const deleteObjects = async (request, database, array) => {
        const inputs = request.object === undefined
            ? []
            : Array.isArray(request.object) ? request.object : [request.object]
        const identified = inputs
            .filter(input => input && typeof input === 'object' && input._id)
            .map(input => String(input._id).toLowerCase())
        let objects

        if (identified.length) {
            objects = []
            for (const objectId of new Set(identified))
                objects.push(await loadObject(database, array, objectId))
        } else {
            const query = normalizeQuery(request)
            if (!hasQueryConditions(query))
                throw new Error('object.delete requires object._id or a query filter')
                objects = await selectObjects(database, array, query, request)
        }

        const deleted = []

        for (const object of objects) {
            const holders = deferred ? new Set() : await captureObjectHolders(database, array, object)
            const file = objectPath(root, database, array, object._id)
            let arrayLengthUpdated = false
            let databaseLengthUpdated = false

            try {
                if (deferred) await rm(file, { force: true })
                else await deleteRecord(storageIndex, database, array, file, object)
                await markDeleted(database, array, object)
                await adjustArrayLength(root, storageIndex, database, array, -1, request)
                arrayLengthUpdated = true
                await adjustDatabaseLengths(root, storageIndex, database, { objects: -1 }, request)
                databaseLengthUpdated = true
            } catch (error) {
                if (databaseLengthUpdated)
                    await adjustDatabaseLengths(root, storageIndex, database, { objects: 1 }, request).catch(() => {})
                if (arrayLengthUpdated)
                    await adjustArrayLength(root, storageIndex, database, array, 1, request).catch(() => {})
                if (!(await readJSON(file)))
                    await createRecord(storageIndex, database, array, file, object).catch(() => {})
                await clearDeletion(database, array, object._id)
                throw error
            }

            deleted.push(tagRecord(object, request))
            if (deferred) {
                queueIndex(database, array, indexEntries(object), object._id, true, object.created?.on)
                pendingIndexes.get(file).removed = object
            } else await publishObjectMutation('remove', database, array, object, holders)
        }

        return deleted
    }

    const readIndex = async (method, database, array, key = '_id') => {
        const databaseRecord = await findRecordByName(
            storageIndex, DATABASE_CATALOG, DATABASE_CATALOG_ARRAY,
            id => databaseMetadataPath(root, id), database
        )
        const databaseId = databaseRecord?._id
        if (!databaseId) return { database, array, key, indexes: {} }
        const arrayRecord = await findRecordByName(
            storageIndex, databaseId, ARRAY_CATALOG,
            id => arrayMetadataPath(root, databaseId, id), array
        )
        const arrayId = arrayRecord?._id
        if (!arrayId) return { database, array, key, indexes: {} }
        return { ...(await storageIndex[method](databaseId, arrayId, key)), database, array }
    }

    const index = {
        read: (database, array, key) => readIndex('read', database, array, key),
        getMetadata: (database, array, key) => readIndex('getMetadata', database, array, key),
        create: async (database, array, key, value, objectId, request = {}) => {
            const databaseMetadata = await ensureDatabase(root, storageIndex, database, {}, request)
            const arrayMetadata = await ensureArray(root, storageIndex, databaseMetadata, array, {}, request)
            let existing = false
            if (key === '_id') {
                for await (const entry of storageIndex.scan(databaseMetadata._id, arrayMetadata._id, key))
                    if (entry.value === value && entry.objectId === objectId) existing = true
            }
            await storageIndex.create(databaseMetadata._id, arrayMetadata._id, key, value, objectId)
            if (key === '_id' && !existing) {
                let arrayLengthUpdated = false
                try {
                    await adjustArrayLength(root, storageIndex, databaseMetadata._id, arrayMetadata._id, 1, request)
                    arrayLengthUpdated = true
                    await adjustDatabaseLengths(root, storageIndex, databaseMetadata._id, { objects: 1 }, request)
                } catch (error) {
                    if (arrayLengthUpdated)
                        await adjustArrayLength(root, storageIndex, databaseMetadata._id, arrayMetadata._id, -1, request).catch(() => {})
                    await storageIndex.delete(databaseMetadata._id, arrayMetadata._id, key, value, objectId).catch(() => {})
                    throw error
                }
            }
        },
        delete: async (database, array, key, value, objectId, request = {}) => {
            const databaseRecord = await findRecordByName(
                storageIndex, DATABASE_CATALOG, DATABASE_CATALOG_ARRAY,
                id => databaseMetadataPath(root, id), database
            )
            const databaseId = databaseRecord?._id
            if (!databaseId) return false
            const arrayRecord = await findRecordByName(
                storageIndex, databaseId, ARRAY_CATALOG,
                id => arrayMetadataPath(root, databaseId, id), array
            )
            const arrayId = arrayRecord?._id
            if (!arrayId) return false
            const removed = await storageIndex.delete(databaseId, arrayId, key, value, objectId)
            if (removed && key === '_id') {
                let arrayLengthUpdated = false
                try {
                    await adjustArrayLength(root, storageIndex, databaseId, arrayId, -1, request)
                    arrayLengthUpdated = true
                    await adjustDatabaseLengths(root, storageIndex, databaseId, { objects: -1 }, request)
                } catch (error) {
                    if (arrayLengthUpdated)
                        await adjustArrayLength(root, storageIndex, databaseId, arrayId, 1, request).catch(() => {})
                    await storageIndex.create(databaseId, arrayId, key, value, objectId).catch(() => {})
                    throw error
                }
            }
            return removed
        },
        scan: async function* (database, array, key = '_id', options = {}) {
            const databaseRecord = await findRecordByName(
                storageIndex, DATABASE_CATALOG, DATABASE_CATALOG_ARRAY,
                id => databaseMetadataPath(root, id), database
            )
            const databaseId = databaseRecord?._id
            if (!databaseId) return
            const arrayRecord = await findRecordByName(
                storageIndex, databaseId, ARRAY_CATALOG,
                id => arrayMetadataPath(root, databaseId, id), array
            )
            const arrayId = arrayRecord?._id
            if (!arrayId) return
            yield* storageIndex.scan(databaseId, arrayId, key, options)
        },
        clearCache: () => storageIndex.clearCache()
    }

    index.update = index.create

    return {
        index,
        resolveDistributionIds,
        updateDistribution,
        getDistribution,
        listDistribution,
        distribution: { local: distributionIndex, peers },
        updatePartition,
        getPartitionHolders,
        listPartitions,
        readIndexPartition: path => storageIndex.readPartition(path),
        applyIndexPartition,
        removeIndexPartition,
        readLocalEntity,
        hydrateObjects,
        applyReplicatedObjectMutation,
        clearDistributionCache: () => distributionIndex.clearCache(),
        ready,
        memoryStats: () => memoryStats(root),
        persistenceStats: () => ({ ...persistence?.stats(), pendingIndexes: pendingIndexes.size, indexError: indexError?.message }),
        flushIndexes,
        holdPersistence: () => persistence?.hold(),
        flushPersistence: () => persistence?.flush(),
        flush,
        async close() {
            closing = true
            await flush()
            if (!sharedPersistence) await persistence?.close()
        },
        async send(request) {
            await ready
            const release = persistence?.hold()
            const response = { ...request }
            // Operators belong to request processing, including when no record matches.
            if (request?.method === 'object.update')
                for (const key of Object.keys(response)) if (key.startsWith('$') && key !== '$update') delete response[key]

            try {
                if (!request || typeof request.method !== 'string')
                    throw new TypeError('CRUD request must include a method')

                const [type, method] = request.method.split('.')

                if (!['create', 'read', 'update', 'delete'].includes(method))
                    throw new Error(`Unsupported CRUD method: ${request.method}`)

                if (type === 'index') {
                    await indexCRUD(method, response, index)
                    response.success = true
                    return response
                }

                if (deferred && method === 'delete' && ['database', 'array'].includes(type)) await flushIndexes()

                if (type === 'database') {
                    if (method === 'read') await resolveAllDatabasesFromPeers()
                    let removedAvailability = []
                    if (method === 'delete' && nodeId) {
                        const names = request.database === undefined
                            ? []
                            : Array.isArray(request.database) ? request.database : [request.database]
                        const entities = []
                        for (const name of names) {
                            const database = await findRecordByName(
                                storageIndex, DATABASE_CATALOG, DATABASE_CATALOG_ARRAY,
                                id => databaseMetadataPath(root, id), name
                            )
                            if (!database) continue
                            const arrays = await readRecords(
                                storageIndex, database._id, ARRAY_CATALOG,
                                id => arrayMetadataPath(root, database._id, id)
                            )
                            for (const array of arrays) {
                                for (const objectId of await localObjectIds(database._id, array._id))
                                    entities.push({ databaseId: database._id, arrayId: array._id, objectId })
                                entities.push({ databaseId: database._id, arrayId: array._id })
                            }
                            entities.push({ databaseId: database._id })
                        }
                        removedAvailability = await prepareAvailabilityRemoval(entities)
                    }

                    try {
                        await sendDatabase(root, storageIndex, method, response)
                    } catch (error) {
                        await restoreAvailability(removedAvailability).catch(() => {})
                        throw error
                    }
                    if (method === 'create') {
                        for (const database of response.database)
                            await markLocalAvailability({ databaseId: database._id }, 'add')
                    }
                    response.success = true
                    return response
                }

                if (type === 'array') {
                    if (method === 'read') {
                        const databaseName = request.database
                        let databaseRecord = await findRecordByName(
                            storageIndex, DATABASE_CATALOG, DATABASE_CATALOG_ARRAY,
                            id => databaseMetadataPath(root, id), databaseName
                        )
                        if (!databaseRecord) databaseRecord = await resolveDatabaseFromPeers(databaseName)
                        if (databaseRecord) await resolveAllArraysFromPeers(databaseRecord)
                    }
                    let removedAvailability = []
                    if (method === 'delete' && nodeId) {
                        const databaseName = request.database
                        const database = await findRecordByName(
                            storageIndex, DATABASE_CATALOG, DATABASE_CATALOG_ARRAY,
                            id => databaseMetadataPath(root, id), databaseName
                        )
                        const names = request.array === undefined
                            ? []
                            : Array.isArray(request.array) ? request.array : [request.array]
                        const entities = []
                        if (database) {
                            for (const name of names) {
                                const array = await findRecordByName(
                                    storageIndex, database._id, ARRAY_CATALOG,
                                    id => arrayMetadataPath(root, database._id, id), name
                                )
                                if (!array) continue
                                for (const objectId of await localObjectIds(database._id, array._id))
                                    entities.push({ databaseId: database._id, arrayId: array._id, objectId })
                                entities.push({ databaseId: database._id, arrayId: array._id })
                            }
                        }
                        removedAvailability = await prepareAvailabilityRemoval(entities)
                    }

                    try {
                        await sendArray(root, storageIndex, method, response)
                    } catch (error) {
                        await restoreAvailability(removedAvailability).catch(() => {})
                        throw error
                    }
                    if (method === 'create') {
                        for (const array of response.array) {
                            await markLocalAvailability({ databaseId: array.databaseId }, 'add')
                            await markLocalAvailability({ databaseId: array.databaseId, arrayId: array._id }, 'add')
                        }
                    }
                    response.success = true
                    return response
                }

                if (type !== 'object')
                    throw new Error(`Unsupported CRUD method: ${request.method}`)

                const databaseName = request.database ?? request.organization_id
                const arrayName = request.array

                if (Array.isArray(databaseName) || Array.isArray(arrayName))
                    throw new TypeError('This filesystem prototype accepts one database and one array per request')

                if (typeof databaseName !== 'string' || !databaseName.trim())
                    throw new TypeError('object CRUD requires a database name')
                if (typeof arrayName !== 'string' || !arrayName.trim())
                    throw new TypeError('object CRUD requires an array name')

                let databaseMetadata = await findRecordByName(
                    storageIndex, DATABASE_CATALOG, DATABASE_CATALOG_ARRAY,
                    id => databaseMetadataPath(root, id), databaseName
                )

                if (method === 'read' && !databaseMetadata)
                    databaseMetadata = await resolveDatabaseFromPeers(databaseName)

                if (method === 'create' || (method === 'update' && request.upsert))
                    databaseMetadata = await ensureDatabase(root, storageIndex, databaseName, {}, request)

                let arrayMetadata = databaseMetadata
                    ? await findRecordByName(
                        storageIndex, databaseMetadata._id, ARRAY_CATALOG,
                        id => arrayMetadataPath(root, databaseMetadata._id, id), arrayName
                    )
                    : undefined

                if (method === 'read' && databaseMetadata && !arrayMetadata)
                    arrayMetadata = await resolveArrayFromPeers(databaseMetadata, arrayName)

                if (method === 'create' || (method === 'update' && request.upsert))
                    arrayMetadata = await ensureArray(root, storageIndex, databaseMetadata, arrayName, {}, request)

                if (!databaseMetadata || !arrayMetadata) {
                    response.database = databaseName
                    response.array = arrayName
                    response.object = []
                    response.success = true
                    return response
                }

                const databaseId = databaseMetadata._id
                const arrayId = arrayMetadata._id

                response.database = databaseName
                response.array = arrayName
                if (method === 'create') {
                    response.object = await createObjects(request, databaseId, arrayId)
                    for (const object of response.object) {
                        await markLocalAvailability({ databaseId }, 'add')
                        await markLocalAvailability({ databaseId, arrayId }, 'add')
                        await markLocalAvailability({ databaseId, arrayId, objectId: object._id }, 'add')
                    }
                }
                else if (method === 'read') response.object = await readObjects(request, databaseId, arrayId)
                else if (method === 'update') {
                    response.object = await updateObjects(request, databaseId, arrayId)
                }
                else {
                    response.object = await deleteObjects(request, databaseId, arrayId)
                    for (const object of response.object)
                        await markLocalAvailability({ databaseId, arrayId, objectId: object._id }, 'remove')
                }
                response.success = true
                return response
            } catch (error) {
                return errorHandler(response, error)
            } finally { release?.() }
        }
    }
}
