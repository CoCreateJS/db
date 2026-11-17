import { mkdir, rm } from '../io.js'
import { ObjectId } from '@cocreate/utils'
import { removeMemoryPath } from '../memory.js'
import {
    DATABASE_CATALOG, DATABASE_CATALOG_ARRAY, ARRAY_CATALOG,
    arrayMetadataPath, auditMetadata, databaseDirectory, databaseMetadataPath, readJSON,
    removeDirectoryPreservingDistribution
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

const normalizeDatabaseMetadata = value => {
    const metadata = { ...value }
    metadata.arrayLength ??= metadata.count ?? metadata.arrayCount ?? 0
    metadata.objectLength ??= metadata.objectCount ?? 0
    delete metadata.count
    delete metadata.arrayCount
    delete metadata.objectCount
    return metadata
}

export async function ensureDatabase(root, index, name, config = {}, request = {}) {
    databaseName(name)
    const existing = await findRecordByName(
        index, DATABASE_CATALOG, DATABASE_CATALOG_ARRAY,
        id => databaseFile(root, id), name
    )
    if (existing) {
        const normalized = normalizeDatabaseMetadata(existing)
        if (JSON.stringify(normalized) !== JSON.stringify(existing))
            return updateRecord(index, DATABASE_CATALOG, DATABASE_CATALOG_ARRAY, databaseFile(root, existing._id), existing, normalized)
        return existing
    }

    const id = ObjectId().toString()
    const audit = auditMetadata(request)
    const record = {
        _id: id,
        name,
        arrayLength: 0,
        objectLength: 0,
        config: { ...validateConfig(config, 'database') },
        created: audit,
        updated: audit
    }
    await mkdir(databaseDirectory(root, id), { recursive: true })

    try {
        return await createRecord(index, DATABASE_CATALOG, DATABASE_CATALOG_ARRAY, databaseFile(root, id), record)
    } catch (error) {
        removeMemoryPath(databaseDirectory(root, id))
        await rm(databaseDirectory(root, id), { recursive: true, force: true }).catch(() => {})
        throw error
    }
}

/** Materialize a remote database catalog record under its existing stable ID. */
export async function materializeDatabase(root, index, source) {
    databaseName(source?.name)
    const record = normalizeDatabaseMetadata(source)
    Object.assign(record, {
        arrayLength: 0,
        objectLength: 0,
        config: source.config && typeof source.config === 'object' && !Array.isArray(source.config)
            ? source.config
            : {}
    })
    const file = databaseFile(root, record._id)
    const current = await readJSON(file)
    if (current) {
        if (JSON.stringify(current) !== JSON.stringify(record))
            await updateRecord(index, DATABASE_CATALOG, DATABASE_CATALOG_ARRAY, file, current, record)
        return record
    }

    await mkdir(databaseDirectory(root, record._id), { recursive: true })
    try {
        return await createRecord(index, DATABASE_CATALOG, DATABASE_CATALOG_ARRAY, file, record)
    } catch (error) {
        removeMemoryPath(databaseDirectory(root, record._id))
        await rm(databaseDirectory(root, record._id), { recursive: true, force: true }).catch(() => {})
        throw error
    }
}

export async function adjustDatabaseLengths(root, index, databaseId, { arrays = 0, objects = 0 }, request = {}) {
    const file = databaseFile(root, databaseId)
    const current = await readJSON(file)
    if (!current) throw new Error(`Database not found: ${databaseId}`)

    const normalized = normalizeDatabaseMetadata(current)
    const arrayLength = normalized.arrayLength + arrays
    const objectLength = normalized.objectLength + objects
    if (!Number.isSafeInteger(arrayLength) || arrayLength < 0 || !Number.isSafeInteger(objectLength) || objectLength < 0)
        throw new Error('Database lengths would become invalid')

    return updateRecord(index, DATABASE_CATALOG, DATABASE_CATALOG_ARRAY, file, current, {
        ...normalized,
        arrayLength,
        objectLength,
        updated: auditMetadata(request)
    })
}

async function databaseRecord(root, index, metadata) {
    const normalizedMetadata = normalizeDatabaseMetadata(metadata)
    if (JSON.stringify(normalizedMetadata) !== JSON.stringify(metadata))
        metadata = await updateRecord(index, DATABASE_CATALOG, DATABASE_CATALOG_ARRAY,
            databaseFile(root, metadata._id), metadata, normalizedMetadata)

    const arrays = await readRecords(
        index,
        metadata._id,
        ARRAY_CATALOG,
        id => arrayFile(root, metadata._id, id)
    )
    const normalizedArrays = await Promise.all(arrays.map(async array => {
        const normalized = normalizeArrayCatalogRecord(array)
        if (JSON.stringify(normalized) === JSON.stringify(array)) return array
        return updateRecord(index, metadata._id, ARRAY_CATALOG,
            arrayFile(root, metadata._id, array._id), array, normalized)
    }))

    return {
        ...normalizeDatabaseMetadata(metadata),
        arrayLength: normalizedArrays.length,
        arrays: normalizedArrays.map(array => ({
            ...normalizeArrayCatalogRecord(array),
            $storage: ['db'],
            $database: [metadata.name]
        })),
        $storage: ['db']
    }
}

function normalizeArrayCatalogRecord(value) {
    const record = { ...value }
    record.length ??= record.count ?? 0
    delete record.count
    return record
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
                await removeDirectoryPreservingDistribution(root, databaseDirectory(root, current._id))
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
