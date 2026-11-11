import { join, resolve } from 'node:path'
import { createUpdate, ObjectId, queryData } from '@cocreate/utils'
import { adjustArrayObjectCount, ensureArray, sendArray } from '../array/index.js'
import { adjustDatabaseCounts, ensureDatabase, sendDatabase } from '../database/index.js'
import createIndex from '../index/index.js'
import { createDistributedIndex } from '../distributed.js'
import {
    ARRAY_CATALOG, DATABASE_CATALOG, DATABASE_CATALOG_ARRAY,
    arrayDirectory, arrayMetadataPath, auditMetadata, databaseDirectory, databaseMetadataPath,
    normalizeObject, objectPath, readJSON, setPath, typeOf
} from '../storage.js'
import { hasQueryConditions, normalizeQuery, queryIndexCandidates } from '../query.js'
import { applyReadFilter } from '../read.js'
import { createRecord, deleteRecord, findRecordByName, readRecordById, readRecords, updateRecord } from '../records.js'

const clone = value => structuredClone(value)

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
    directory = './storage', maxIndexBytes = 128 * 1024, cache = false,
    nodeId, distributedAdapter
} = {}) {
    const root = resolve(directory)
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

    const createObjects = async (request, database, array) => {
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
            let countedArray = false
            let countedDatabase = false

            try {
                await createRecord(storageIndex, database, array, file, object)
                wroteObject = true
                await adjustArrayObjectCount(root, storageIndex, database, array, 1, request)
                countedArray = true
                await adjustDatabaseCounts(root, storageIndex, database, { objects: 1 }, request)
                countedDatabase = true
            } catch (error) {
                if (countedDatabase)
                    await adjustDatabaseCounts(root, storageIndex, database, { objects: -1 }, request).catch(() => {})
                if (countedArray)
                    await adjustArrayObjectCount(root, storageIndex, database, array, -1, request).catch(() => {})
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
        }

        return created
    }

    const loadObject = async (database, array, objectId) => {
        const file = objectPath(root, database, array, objectId)
        const object = await readRecordById(storageIndex, database, array, () => file, objectId)
        if (!object) throw new Error(`Object file not found: ${objectId}`)
        return object
    }

    const selectObjects = async (database, array, query) => {
        const { ids } = await queryIndexCandidates(storageIndex, database, array, query)
        const objects = []

        for (const objectId of ids) {
            const object = await loadObject(database, array, objectId)
            if (queryData(object, query)) objects.push(object)
        }

        return objects
    }

    const readObjects = async (request, database, array) => {
        const query = normalizeQuery(request)
        const objects = await selectObjects(database, array, query)
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
                const current = await loadObject(database, array, String(input._id).toLowerCase())
                targets.push({ current, input })
            }
        } else {
            if (!request.filter?.query)
                throw new Error('object.update requires object._id or filter.query')
            if (inputs.length !== 1)
                throw new Error('A filtered update accepts one update object')

            const query = normalizeQuery(request)
            const currentObjects = await selectObjects(database, array, query)
            for (const current of currentObjects)
                targets.push({ current, input: inputs[0] })
        }

        const updatedObjects = []

        for (const { current, input } of targets) {
            const updated = applyObjectUpdate(current, input, request)
            await updateStoredObject(database, array, current, updated)
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
            objects = await selectObjects(database, array, query)
        }

        const deleted = []

        for (const object of objects) {
            const file = objectPath(root, database, array, object._id)
            let countedArray = false
            let countedDatabase = false

            try {
                await deleteRecord(storageIndex, database, array, file, object)
                await adjustArrayObjectCount(root, storageIndex, database, array, -1, request)
                countedArray = true
                await adjustDatabaseCounts(root, storageIndex, database, { objects: -1 }, request)
                countedDatabase = true
            } catch (error) {
                if (countedDatabase)
                    await adjustDatabaseCounts(root, storageIndex, database, { objects: 1 }, request).catch(() => {})
                if (countedArray)
                    await adjustArrayObjectCount(root, storageIndex, database, array, 1, request).catch(() => {})
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
        }

        return deleted
    }

    const index = {
        get: async (database, array, key = '_id') => {
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
            return { ...(await storageIndex.get(databaseId, arrayId, key)), database, array }
        },
        set: async (database, array, key, value, objectId) => {
            const databaseMetadata = await ensureDatabase(root, storageIndex, database, {}, request)
            const arrayMetadata = await ensureArray(root, storageIndex, databaseMetadata, array, {}, request)
            let existing = false
            if (key === '_id') {
                for await (const entry of storageIndex.scan(databaseMetadata._id, arrayMetadata._id, key))
                    if (entry.value === value && entry.objectId === objectId) existing = true
            }
            await storageIndex.set(databaseMetadata._id, arrayMetadata._id, key, value, objectId)
            if (key === '_id' && !existing) {
                let arrayCounted = false
                try {
                    await adjustArrayObjectCount(root, storageIndex, databaseMetadata._id, arrayMetadata._id, 1, request)
                    arrayCounted = true
                    await adjustDatabaseCounts(root, storageIndex, databaseMetadata._id, { objects: 1 }, request)
                } catch (error) {
                    if (arrayCounted)
                        await adjustArrayObjectCount(root, storageIndex, databaseMetadata._id, arrayMetadata._id, -1, request).catch(() => {})
                    await storageIndex.remove(databaseMetadata._id, arrayMetadata._id, key, value, objectId).catch(() => {})
                    throw error
                }
            }
        },
        remove: async (database, array, key, value, objectId) => {
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
                let arrayCounted = false
                try {
                    await adjustArrayObjectCount(root, storageIndex, databaseId, arrayId, -1, request)
                    arrayCounted = true
                    await adjustDatabaseCounts(root, storageIndex, databaseId, { objects: -1 }, request)
                } catch (error) {
                    if (arrayCounted)
                        await adjustArrayObjectCount(root, storageIndex, databaseId, arrayId, 1, request).catch(() => {})
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
        clearDistributedCache: () => distributedIndex.clearCache(),
        async send(request) {
            const response = { ...request }

            try {
                if (!request || typeof request.method !== 'string')
                    throw new TypeError('CRUD request must include a method')

                const [type, method] = request.method.split('.')

                if (!['create', 'read', 'update', 'delete'].includes(method))
                    throw new Error(`Unsupported CRUD method: ${request.method}`)

                if (type === 'database') {
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

                if (method === 'create')
                    databaseMetadata = await ensureDatabase(root, storageIndex, databaseName, {}, request)

                let arrayMetadata = databaseMetadata
                    ? await findRecordByName(
                        storageIndex, databaseMetadata._id, ARRAY_CATALOG,
                        id => arrayMetadataPath(root, databaseMetadata._id, id), arrayName
                    )
                    : undefined

                if (method === 'create')
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
