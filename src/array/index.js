import { mkdir, rm } from 'node:fs/promises'
import { ObjectId } from '@cocreate/utils'
import { ARRAY_CATALOG, arrayDirectory, arrayMetadataPath, auditMetadata, databaseMetadataPath, readJSON, removeDirectoryPreservingDistributed } from '../storage.js'
import { createRecord, deleteRecord, findRecordByName, readRecords, updateRecord } from '../records.js'
import { adjustDatabaseCounts, ensureDatabase } from '../database/index.js'
import { applyReadFilter } from '../read.js'

const arrayName = name => {
    if (typeof name !== 'string' || !name.trim())
        throw new TypeError('array name must be a non-empty string')
    return name
}

const validateConfig = config => {
    if (!config || typeof config !== 'object' || Array.isArray(config))
        throw new TypeError('array.config must be an object')
    return config
}

const arrayFile = (root, databaseId, arrayId) => arrayMetadataPath(root, databaseId, arrayId)
const databaseFile = (root, databaseId) => databaseMetadataPath(root, databaseId)

export async function ensureArray(root, index, database, name, config = {}, request = {}) {
    arrayName(name)
    const existing = await findRecordByName(
        index, database._id, ARRAY_CATALOG,
        id => arrayFile(root, database._id, id), name
    )
    if (existing) return existing

    const id = ObjectId().toString()
    const audit = auditMetadata(request)
    const record = {
        _id: id,
        name,
        databaseId: database._id,
        count: 0,
        config: { ...validateConfig(config) },
        created: audit,
        updated: audit
    }
    const directory = arrayDirectory(root, database._id, id)
    await mkdir(directory, { recursive: true })

    try {
        await createRecord(index, database._id, ARRAY_CATALOG, arrayFile(root, database._id, id), record)
        await adjustDatabaseCounts(root, index, database._id, { arrays: 1 }, request)
    } catch (error) {
        const persisted = await readJSON(arrayFile(root, database._id, id))
        if (persisted)
            await deleteRecord(index, database._id, ARRAY_CATALOG, arrayFile(root, database._id, id), persisted).catch(() => {})
        await rm(directory, { recursive: true, force: true }).catch(() => {})
        throw error
    }

    return record
}

async function arrayRecord(root, index, database, metadata) {
    return {
        ...metadata,
        $storage: ['db'],
        $database: [database.name]
    }
}

async function resolveDatabase(root, index, name) {
    return findRecordByName(index, '__catalog__', 'databases', id => databaseFile(root, id), name)
}

export async function adjustArrayObjectCount(root, index, databaseId, arrayId, delta, request = {}) {
    const file = arrayFile(root, databaseId, arrayId)
    const current = await readJSON(file)
    if (!current) throw new Error(`Array not found: ${arrayId}`)

    const count = current.count + delta
    if (!Number.isSafeInteger(count) || count < 0)
        throw new Error('Array object count would become invalid')

    return updateRecord(index, databaseId, ARRAY_CATALOG, file, current, {
        ...current,
        count,
        updated: auditMetadata(request)
    })
}

async function readArrays(root, index, database, request) {
    const records = await readRecords(
        index,
        database._id,
        ARRAY_CATALOG,
        id => arrayFile(root, database._id, id)
    )
    const enriched = records.map(record => ({
        ...record,
        $storage: ['db'],
        $database: [database.name]
    }))
    return applyReadFilter(enriched, request, {
        database: database.name,
        array: ARRAY_CATALOG
    })
}

export async function sendArray(root, index, method, request) {
    const databaseName = request.database
    if (typeof databaseName !== 'string' || !databaseName)
        throw new TypeError(`array.${method} requires one database name`)

    let database = await resolveDatabase(root, index, databaseName)
    if (method === 'create' && !database)
        database = await ensureDatabase(root, index, databaseName, {}, request)

    if (!database) {
        if (method === 'read' || method === 'delete') {
            request.array = []
            return request.array
        }
        throw new Error(`Database not found: ${databaseName}`)
    }

    if (method === 'read') {
        request.array = await readArrays(root, index, database, request)
        return request.array
    }

    if (method === 'create') {
        const names = request.array === undefined
            ? []
            : Array.isArray(request.array) ? request.array : [request.array]
        if (!names.length) throw new TypeError('array.create requires an array name')
        const records = []

        for (const value of names) {
            const metadata = await ensureArray(root, index, database, arrayName(value), request.config, request)
            records.push(await arrayRecord(root, index, database, metadata))
        }

        request.array = records
        return records
    }

    if (method === 'update') {
        const oldName = arrayName(request.array)
        const newName = arrayName(request.name ?? request.newName ?? oldName)
        if (request.config === undefined && newName === oldName)
            throw new Error('array.update requires a new name or config')

        const current = await findRecordByName(
            index, database._id, ARRAY_CATALOG,
            id => arrayFile(root, database._id, id), oldName
        )
        if (!current) throw new Error(`Array not found: ${oldName}`)

        const collision = await findRecordByName(
            index, database._id, ARRAY_CATALOG,
            id => arrayFile(root, database._id, id), newName
        )
        if (collision && collision._id !== current._id)
            throw new Error(`Array already exists: ${newName}`)

        const updated = {
            ...current,
            name: newName,
            config: request.config === undefined
                ? current.config
                : { ...current.config, ...validateConfig(request.config) },
            updated: auditMetadata(request)
        }
        const metadata = await updateRecord(
            index, database._id, ARRAY_CATALOG,
            arrayFile(root, database._id, current._id), current, updated
        )
        request.array = [await arrayRecord(root, index, database, metadata)]
        return request.array
    }

    if (method === 'delete') {
        const names = request.array === undefined
            ? []
            : Array.isArray(request.array) ? request.array : [request.array]
        const records = []

        for (const value of names) {
            const name = arrayName(value)
            const current = await findRecordByName(
                index, database._id, ARRAY_CATALOG,
                id => arrayFile(root, database._id, id), name
            )
            if (!current) continue

            const result = await arrayRecord(root, index, database, current)
            await adjustDatabaseCounts(root, index, database._id, {
                arrays: -1,
                objects: -current.count
            }, request)
            try {
                await deleteRecord(index, database._id, ARRAY_CATALOG, arrayFile(root, database._id, current._id), current)
                await removeDirectoryPreservingDistributed(root, arrayDirectory(root, database._id, current._id))
            } catch (error) {
                await mkdir(arrayDirectory(root, database._id, current._id), { recursive: true }).catch(() => {})
                await createRecord(index, database._id, ARRAY_CATALOG, arrayFile(root, database._id, current._id), current).catch(() => {})
                await adjustDatabaseCounts(root, index, database._id, {
                    arrays: 1,
                    objects: current.count
                }, request).catch(() => {})
                throw error
            }
            records.push(result)
        }

        request.array = records
        return records
    }

    throw new Error(`Unsupported CRUD method: array.${method}`)
}
