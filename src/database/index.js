import { mkdir, rm } from 'node:fs/promises'
import { ObjectId } from '@cocreate/utils'
import {
    DATABASE_CATALOG, DATABASE_CATALOG_ARRAY, ARRAY_CATALOG,
    arrayMetadataPath, auditMetadata, databaseDirectory, databaseMetadataPath, readJSON,
    removeDirectoryPreservingDistributed
} from '../storage.js'
import { createRecord, deleteRecord, findRecordByName, readRecords, updateRecord } from '../records.js'
import { applyReadFilter } from '../read.js'

const databaseName = name => {
    if (typeof name !== 'string' || !name.trim())
        throw new TypeError('database name must be a non-empty string')
    return name
}

const validateConfig = (config, label) => {
    if (!config || typeof config !== 'object' || Array.isArray(config))
        throw new TypeError(`${label}.config must be an object`)
    return config
}

const databaseFile = (root, id) => databaseMetadataPath(root, id)
const arrayFile = (root, databaseId, id) => arrayMetadataPath(root, databaseId, id)

export async function ensureDatabase(root, index, name, config = {}, request = {}) {
    databaseName(name)
    const existing = await findRecordByName(
        index, DATABASE_CATALOG, DATABASE_CATALOG_ARRAY,
        id => databaseFile(root, id), name
    )
    if (existing) return existing

    const id = ObjectId().toString()
    const audit = auditMetadata(request)
    const record = {
        _id: id,
        name,
        count: 0,
        objectCount: 0,
        config: { ...validateConfig(config, 'database') },
        created: audit,
        updated: audit
    }
    await mkdir(databaseDirectory(root, id), { recursive: true })

    try {
        return await createRecord(index, DATABASE_CATALOG, DATABASE_CATALOG_ARRAY, databaseFile(root, id), record)
    } catch (error) {
        await rm(databaseDirectory(root, id), { recursive: true, force: true }).catch(() => {})
        throw error
    }
}

export async function adjustDatabaseCounts(root, index, databaseId, { arrays = 0, objects = 0 }, request = {}) {
    const file = databaseFile(root, databaseId)
    const current = await readJSON(file)
    if (!current) throw new Error(`Database not found: ${databaseId}`)

    const count = current.count + arrays
    const objectCount = current.objectCount + objects
    if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(objectCount) || objectCount < 0)
        throw new Error('Database counts would become invalid')

    return updateRecord(index, DATABASE_CATALOG, DATABASE_CATALOG_ARRAY, file, current, {
        ...current,
        count,
        objectCount,
        updated: auditMetadata(request)
    })
}

async function databaseRecord(root, index, metadata) {
    const arrays = await readRecords(
        index,
        metadata._id,
        ARRAY_CATALOG,
        id => arrayFile(root, metadata._id, id)
    )

    return {
        ...metadata,
        count: arrays.length,
        arrayCount: arrays.length,
        arrays: arrays.map(array => ({
            ...array,
            $storage: ['db'],
            $database: [metadata.name]
        })),
        $storage: ['db']
    }
}

async function readDatabases(root, index, request) {
    const metadata = await readRecords(
        index,
        DATABASE_CATALOG,
        DATABASE_CATALOG_ARRAY,
        id => databaseFile(root, id)
    )
    const records = []
    for (const database of metadata)
        records.push(await databaseRecord(root, index, database))

    return applyReadFilter(records, request, {
        database: DATABASE_CATALOG,
        array: DATABASE_CATALOG_ARRAY
    })
}

export async function sendDatabase(root, index, method, request) {
    if (method === 'read') {
        request.database = await readDatabases(root, index, request)
        return request.database
    }

    if (method === 'create') {
        const names = request.database === undefined
            ? []
            : Array.isArray(request.database) ? request.database : [request.database]
        if (!names.length) throw new TypeError('database.create requires a database name')
        const records = []

        for (const value of names) {
            const database = await ensureDatabase(root, index, databaseName(value), request.config, request)
            records.push(await databaseRecord(root, index, database))
        }

        request.database = records
        return records
    }

    if (method === 'update') {
        const oldName = databaseName(request.database)
        const newName = databaseName(request.name ?? request.newName ?? oldName)
        if (request.config === undefined && newName === oldName)
            throw new Error('database.update requires a new name or config')

        const current = await findRecordByName(
            index, DATABASE_CATALOG, DATABASE_CATALOG_ARRAY,
            id => databaseFile(root, id), oldName
        )
        if (!current) throw new Error(`Database not found: ${oldName}`)

        const collision = await findRecordByName(
            index, DATABASE_CATALOG, DATABASE_CATALOG_ARRAY,
            id => databaseFile(root, id), newName
        )
        if (collision && collision._id !== current._id)
            throw new Error(`Database already exists: ${newName}`)

        const updated = {
            ...current,
            name: newName,
            config: request.config === undefined
                ? current.config
                : { ...current.config, ...validateConfig(request.config, 'database') },
            updated: auditMetadata(request)
        }
        const metadata = await updateRecord(
            index, DATABASE_CATALOG, DATABASE_CATALOG_ARRAY,
            databaseFile(root, current._id), current, updated
        )
        request.database = [await databaseRecord(root, index, metadata)]
        return request.database
    }

    if (method === 'delete') {
        const names = request.database === undefined
            ? []
            : Array.isArray(request.database) ? request.database : [request.database]
        const records = []

        for (const value of names) {
            const name = databaseName(value)
            const current = await findRecordByName(
                index, DATABASE_CATALOG, DATABASE_CATALOG_ARRAY,
                id => databaseFile(root, id), name
            )
            if (!current) continue

            const result = await databaseRecord(root, index, current)
            await deleteRecord(index, DATABASE_CATALOG, DATABASE_CATALOG_ARRAY, databaseFile(root, current._id), current)
            try {
                await removeDirectoryPreservingDistributed(root, databaseDirectory(root, current._id))
            } catch (error) {
                await createRecord(index, DATABASE_CATALOG, DATABASE_CATALOG_ARRAY, databaseFile(root, current._id), current).catch(() => {})
                throw error
            }
            records.push(result)
        }

        request.database = records
        return records
    }

    throw new Error(`Unsupported CRUD method: database.${method}`)
}
