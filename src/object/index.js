import { join, resolve } from 'node:path'
import { rm } from 'node:fs/promises'
import { createUpdate, ObjectId, queryData } from '@cocreate/utils'
import { adjustArrayLength, ensureArray, materializeArray, sendArray } from '../array/index.js'
import { adjustDatabaseLengths, ensureDatabase, materializeDatabase, sendDatabase } from '../database/index.js'
import createIndex from '../index/index.js'
import { createDistributedIndex } from '../distributed.js'
import {
    ARRAY_CATALOG, DATABASE_CATALOG, DATABASE_CATALOG_ARRAY,
    arrayDirectory, arrayMetadataPath, auditMetadata, databaseDirectory, databaseMetadataPath,
    normalizeObject, objectPath, readJSON, replaceJSON, setPath, typeOf, flattenIndexValues
} from '../storage.js'
import { hasQueryConditions, normalizeQuery, queryIndexCandidates } from '../query.js'
import { applyReadFilter } from '../read.js'
import { createRecord, deleteRecord, findRecordByName, readRecordById, readRecords, updateRecord } from '../records.js'
import { preloadDirectory, memoryStats, removeMemoryPath } from '../memory.js'

const clone = value => structuredClone(value)
const isObjectId = value => typeof value === 'string' && /^[0-9a-f]{24}$/i.test(value)

function assertSafeUpdatePath(path) {
    const keys = String(path).replace(/\[(\d+)\]/g, '.$1').split('.')
    if (keys.some(key => !key || ['__proto__', 'prototype', 'constructor'].includes(key)))
        throw new TypeError(`Invalid object key path: ${path}`)
    if (keys[0] === '_id')
        throw new Error('object._id cannot be changed')
}

function validateUpdatePaths(input) {
    for (const [key, value] of Object.entries(input)) {
        if (key === '_id' || key === 'filter' || ['$storage', '$database', '$array'].includes(key))
            continue

        if (!key.startsWith('$')) {
            assertSafeUpdatePath(key)
            continue
        }

        if (key.includes('.')) {
            const [operator, ...path] = key.split('.')
            assertSafeUpdatePath(path.join('.'))
            if (operator === '$rename') assertSafeUpdatePath(value)
            continue
        }

        for (const path of Object.keys(value || {})) {
            assertSafeUpdatePath(path)
            if (key === '$rename') assertSafeUpdatePath(value[path])
        }
    }
}

function applyObjectUpdate(current, input, request) {
    const updated = clone(current)

    if (input._id && input._id !== current._id)
        throw new Error('object._id cannot be changed')

    validateUpdatePaths(input)

    const updateData = {}
    for (const [key, value] of Object.entries(input)) {
        if (key === 'filter' || ['$storage', '$database', '$array'].includes(key)) continue
        if (key === '$set') Object.assign(updateData, value || {})
        else if (key.startsWith('$set.')) updateData[key.slice(5)] = value
        else updateData[key] = value
    }

    const globalOperators = {}
    for (const [operator, values] of Object.entries(request)) {
        if (!operator.startsWith('$') || !values || typeof values !== 'object') continue
        for (const [path, value] of Object.entries(values))
            globalOperators[`${operator}.${path}`] = value
    }

    if (createUpdate(updated, updateData, globalOperators) === false)
        throw new Error('Shared update utility could not apply the requested update')

    setPath(updated, 'updated', auditMetadata(request))

    return updated
}

/**
 * Create a filesystem-backed CoCreateDB instance.
 * The configured directory contains database/array index files and object JSON files.
 */
export function createDB({
    directory = './storage', maxIndexBytes = 128 * 1024, cache = false, memoryCache = false,
    nodeId, distributedAdapter, peerReader, partitionAdapter, documentMutationAdapter
} = {}) {
    const root = resolve(directory)
    const ready = memoryCache ? preloadDirectory(root) : Promise.resolve({ files: 0 })
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
    const distributedIndex = createDistributedIndex({
        directory: root,
        maxBytes: maxIndexBytes,
        cache
    })

    const resolveDistributedIds = async ({ database, databaseId, array, arrayId, objectId }) => {
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

    const updateLocalDistributed = payload => distributedIndex.update(payload)
    const getLocalDistributed = payload => distributedIndex.get(payload)
    const listLocalDistributed = payload => distributedIndex.list(payload)
    const updateLocalPartition = payload => distributedIndex.updatePartition(payload)
    const getLocalPartition = partitionId => distributedIndex.getPartition(partitionId)
    const listLocalPartitions = () => distributedIndex.listPartitions()

    const updateDistributed = async request => {
        const ids = await resolveDistributedIds(request)
        const payload = { ...ids, nodeId: request.nodeId, operation: request.operation }
        return distributedAdapter?.update
            ? distributedAdapter.update(payload, updateLocalDistributed)
            : updateLocalDistributed(payload)
    }

    const getDistributed = async request => {
        const ids = await resolveDistributedIds(request)
        return distributedAdapter?.get
            ? distributedAdapter.get(ids, getLocalDistributed)
            : getLocalDistributed(ids)
    }

    const listDistributed = async request => distributedAdapter?.list
        ? distributedAdapter.list(request, listLocalDistributed)
        : listLocalDistributed(request)

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
        if (distributedAdapter?.onLocalChange)
            return distributedAdapter.onLocalChange(payload, updateLocalDistributed)
        return updateLocalDistributed(payload)
    }

    const localObjectIds = async (databaseId, arrayId) => {
        const ids = []
        for await (const entry of storageIndex.scan(databaseId, arrayId, '_id', { type: 'string' }))
            ids.push(entry.value)
        return ids
    }

    const captureObjectHolders = async (database, array, object) => {
        const holders = new Set()
        for (const [key, value] of flattenIndexValues(object)) {
            if (key === '_id') continue
            const path = await storageIndex.locatePartition(database, array, key, value, object._id)
            if (!path) continue
            for (const holder of await getPartitionHolders(path)) holders.add(holder)
        }
        return holders
    }

    const publishObjectMutation = async (operation, databaseId, arrayId, object, holders) => {
        if (!documentMutationAdapter?.publish || !holders.size) return
        await documentMutationAdapter.publish({
            operation,
            databaseId,
            arrayId,
            object: clone(object),
            database: await readJSON(databaseMetadataPath(root, databaseId)),
            array: await readJSON(arrayMetadataPath(root, databaseId, arrayId)),
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
            object.created ??= { ...audit }
            object.updated ??= { ...audit }

            const file = objectPath(root, database, array, object._id)
            let wroteObject = false
            let arrayLengthUpdated = false
            let databaseLengthUpdated = false

            try {
                await createRecord(storageIndex, database, array, file, object)
                wroteObject = true
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
                throw error
            }

            created.push({
                ...clone(object),
                $storage: ['db'],
                $database: [request.database ?? request.organization_id],
                $array: [request.array]
            })
            if (publishMutation) {
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

    const applyReplicatedObjectMutation = async ({ operation, database, array, object }) => {
        if (!['set', 'remove'].includes(operation) || !object || !isObjectId(object._id))
            throw new TypeError('Invalid replicated object mutation')
        const databaseId = database?._id
        const arrayId = array?._id
        if (!isObjectId(databaseId) || !isObjectId(arrayId) || database._id !== databaseId || array._id !== arrayId)
            throw new TypeError('Replicated object mutation requires database and array metadata')

        await replaceJSON(databaseMetadataPath(root, databaseId), database)
        await replaceJSON(arrayMetadataPath(root, databaseId, arrayId), array)
        const file = objectPath(root, databaseId, arrayId, object._id)
        if (operation === 'remove') {
            removeMemoryPath(file)
            await rm(file, { force: true })
        }
        else await replaceJSON(file, object)

        await markLocalAvailability({ databaseId }, 'add')
        await markLocalAvailability({ databaseId, arrayId }, 'add')
        await markLocalAvailability({ databaseId, arrayId, objectId: object._id }, operation === 'remove' ? 'remove' : 'add')
        return true
    }

    const acquireEntity = async (type, databaseId, arrayId, objectId) => {
        if (!peerReader) return undefined
        const refs = type === 'database'
            ? await getDistributed({ databaseId })
            : type === 'array'
                ? await getDistributed({ databaseId, arrayId })
                : await getDistributed({ databaseId, arrayId, objectId })

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
        for (const { id, nodeIds } of await listDistributed()) {
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
        for (const { id, nodeIds } of await listDistributed({ databaseId: database._id })) {
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
        for (const { id } of await listDistributed())
            if (isObjectId(id) && !(await readJSON(databaseMetadataPath(root, id))))
                await materializeDatabaseFromPeer(id)
    }

    const resolveAllArraysFromPeers = async database => {
        for (const { id } of await listDistributed({ databaseId: database._id }))
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
            if (!record) return undefined

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
        const acquired = await materializeObjectFromPeer(database, array, objectId, request)
        if (acquired) return acquired
        throw new Error(`Object file not found: ${objectId}`)
    }

    const selectObjects = async (database, array, query, request = {}) => {
        const hydrated = new Map()
        const readForPlanning = async objectId => {
            if (hydrated.has(objectId)) return hydrated.get(objectId)
            const object = await loadObject(database, array, objectId, request)
            hydrated.set(objectId, object)
            return object
        }
        const { ids } = await queryIndexCandidates(storageIndex, database, array, query, {
            readObject: readForPlanning
        })
        const objects = []

        for (const objectId of ids) {
            const object = hydrated.get(objectId) ?? await loadObject(database, array, objectId, request)
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
                await materializeObjectFromPeer(database, array, objectId.toLowerCase(), request)

        const objects = await selectObjects(database, array, query, request)
        return applyReadFilter(objects, request, {
            database: request.database ?? request.organization_id,
            array: request.array,
            query
        }).map(object => ({
            ...object,
            $database: [request.database ?? request.organization_id],
            $array: [request.array]
        }))
    }

    const updateStoredObject = async (database, array, current, updated) => {
        const file = objectPath(root, database, array, current._id)
        return updateRecord(storageIndex, database, array, file, current, updated)
    }

    const updateObjects = async (request, database, array) => {
        const inputs = request.object === undefined
            ? []
            : Array.isArray(request.object) ? request.object : [request.object]

        if (!inputs.length)
            throw new Error('object.update requires object data')

        const identified = inputs.filter(input => input && typeof input === 'object' && input._id)
        const targets = []

        if (identified.length) {
            if (identified.length !== inputs.length)
                throw new Error('Each object in a multi-object update must include _id')

            for (const input of identified) {
                const objectId = String(input._id).toLowerCase()
                const current = await readLocalObject(database, array, objectId) ??
                    await materializeObjectFromPeer(database, array, objectId, request)

                if (!current) {
                    if (request.upsert && inputs.length === 1)
                        return createObjects({
                            ...request,
                            method: 'object.create',
                            object: input
                        }, database, array)

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
            return createObjects({
                ...request,
                method: 'object.create',
                object: inputs[0]
            }, database, array)
        }

        const updatedObjects = []

        for (const { current, input } of targets) {
            const holders = await captureObjectHolders(database, array, current)
            const updated = applyObjectUpdate(current, input, request)
            await updateStoredObject(database, array, current, updated)
            for (const holder of await captureObjectHolders(database, array, updated)) holders.add(holder)
            await publishObjectMutation('set', database, array, updated, holders)
            updatedObjects.push({
                ...updated,
                $storage: ['db'],
                $database: [request.database ?? request.organization_id],
                $array: [request.array]
            })
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
            const holders = await captureObjectHolders(database, array, object)
            const file = objectPath(root, database, array, object._id)
            let arrayLengthUpdated = false
            let databaseLengthUpdated = false

            try {
                await deleteRecord(storageIndex, database, array, file, object)
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
                throw error
            }

            deleted.push({
                ...object,
                $storage: ['db'],
                $database: [request.database ?? request.organization_id],
                $array: [request.array]
            })
            await publishObjectMutation('remove', database, array, object, holders)
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
        get: (database, array, key) => readIndex('get', database, array, key),
        getMetadata: (database, array, key) => readIndex('getMetadata', database, array, key),
        set: async (database, array, key, value, objectId, request = {}) => {
            const databaseMetadata = await ensureDatabase(root, storageIndex, database, {}, request)
            const arrayMetadata = await ensureArray(root, storageIndex, databaseMetadata, array, {}, request)
            let existing = false
            if (key === '_id') {
                for await (const entry of storageIndex.scan(databaseMetadata._id, arrayMetadata._id, key))
                    if (entry.value === value && entry.objectId === objectId) existing = true
            }
            await storageIndex.set(databaseMetadata._id, arrayMetadata._id, key, value, objectId)
            if (key === '_id' && !existing) {
                let arrayLengthUpdated = false
                try {
                    await adjustArrayLength(root, storageIndex, databaseMetadata._id, arrayMetadata._id, 1, request)
                    arrayLengthUpdated = true
                    await adjustDatabaseLengths(root, storageIndex, databaseMetadata._id, { objects: 1 }, request)
                } catch (error) {
                    if (arrayLengthUpdated)
                        await adjustArrayLength(root, storageIndex, databaseMetadata._id, arrayMetadata._id, -1, request).catch(() => {})
                    await storageIndex.remove(databaseMetadata._id, arrayMetadata._id, key, value, objectId).catch(() => {})
                    throw error
                }
            }
        },
        remove: async (database, array, key, value, objectId, request = {}) => {
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
            const removed = await storageIndex.remove(databaseId, arrayId, key, value, objectId)
            if (removed && key === '_id') {
                let arrayLengthUpdated = false
                try {
                    await adjustArrayLength(root, storageIndex, databaseId, arrayId, -1, request)
                    arrayLengthUpdated = true
                    await adjustDatabaseLengths(root, storageIndex, databaseId, { objects: -1 }, request)
                } catch (error) {
                    if (arrayLengthUpdated)
                        await adjustArrayLength(root, storageIndex, databaseId, arrayId, 1, request).catch(() => {})
                    await storageIndex.set(databaseId, arrayId, key, value, objectId).catch(() => {})
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

    return {
        index,
        updateDistributed,
        getDistributed,
        listDistributed,
        updatePartition,
        getPartitionHolders,
        listPartitions,
        readIndexPartition: path => storageIndex.readPartition(path),
        applyIndexPartition,
        removeIndexPartition,
        readLocalEntity,
        applyReplicatedObjectMutation,
        clearDistributedCache: () => distributedIndex.clearCache(),
        ready,
        memoryStats: () => memoryStats(root),
        async send(request) {
            await ready
            const response = { ...request }

            try {
                if (!request || typeof request.method !== 'string')
                    throw new TypeError('CRUD request must include a method')

                const [type, method] = request.method.split('.')

                if (!['create', 'read', 'update', 'delete'].includes(method))
                    throw new Error(`Unsupported CRUD method: ${request.method}`)

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
                else if (method === 'update') response.object = await updateObjects(request, databaseId, arrayId)
                else {
                    response.object = await deleteObjects(request, databaseId, arrayId)
                    for (const object of response.object)
                        await markLocalAvailability({ databaseId, arrayId, objectId: object._id }, 'remove')
                }
                response.success = true
                return response
            } catch (error) {
                response.success = false
                response.error = error.message
                return response
            }
        }
    }
}
