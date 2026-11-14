import { rm } from '../io.js'
import { ObjectId } from '@cocreate/utils'
import { DATABASE_CATALOG, DATABASE_CATALOG_ARRAY, ARRAY_CATALOG, arrayMetadataPath,
    databaseMetadataPath, objectPath, auditMetadata } from '../storage.js'
import { createRecord, deleteRecord, findRecordByName, readRecordById, readRecords, updateRecord } from '../records.js'
import { fileId, identify, newFileId } from '../files.js'
import { ensureDatabase, adjustDatabaseLengths } from '../database/index.js'
import { applyReadFilter } from '../read.js'

const name = value => {
    if (typeof value !== 'string' || !value.trim()) throw new TypeError('array name must be a non-empty string')
    return value
}
const find = (root, index, database, value) => findRecordByName(index, database._id, ARRAY_CATALOG, uuid => arrayMetadataPath(root, database._id, uuid), value)

export async function ensureArray(root, index, database, value, config = {}, request = {}) {
    name(value)
    const existing = await find(root, index, database, value)
    if (existing) return existing
    const id = ObjectId().toString()
    const record = { _id: id, name: value, databaseId: database._id, index: index.catalogId(database._id, id), length: 0,
        config, created: auditMetadata(request), updated: auditMetadata(request) }
    await index.ensureCatalog(database._id, id)
    await createRecord(index, database._id, ARRAY_CATALOG, arrayMetadataPath(root, database._id, newFileId()), record)
    await adjustDatabaseLengths(root, index, database._id, { arrays: 1 }, request)
    return record
}

export async function materializeArray(root, index, database, source) {
    name(source?.name)
    if (source.databaseId !== database._id) throw new Error('Remote array belongs to a different database')
    const current = await readRecordById(index, database._id, ARRAY_CATALOG, uuid => arrayMetadataPath(root, database._id, uuid), fileId(source))
    if (current) return updateRecord(index, database._id, ARRAY_CATALOG, arrayMetadataPath(root, database._id, fileId(current)), current, source)
    return createRecord(index, database._id, ARRAY_CATALOG, arrayMetadataPath(root, database._id, fileId(source)), source)
}

export async function adjustArrayLength(root, index, databaseId, id, delta, request = {}) {
    const record = await readRecordById(index, databaseId, ARRAY_CATALOG, uuid => arrayMetadataPath(root, databaseId, uuid), id)
    if (!record) throw new Error(`Array not found: ${id}`)
    if (record.length + delta < 0) throw new Error('Array length would become invalid')
    return updateRecord(index, databaseId, ARRAY_CATALOG, arrayMetadataPath(root, databaseId, fileId(record)), record, value => {
        value.length += delta
        value.updated = auditMetadata(request)
    })
}

export async function sendArray(root, index, method, data) {
    if (typeof data.database !== 'string' || !data.database) throw new TypeError(`array.${method} requires one database name`)
    let database = await findRecordByName(index, DATABASE_CATALOG, DATABASE_CATALOG_ARRAY, uuid => databaseMetadataPath(root, uuid), data.database)
    if (!database && method === 'create') database = await ensureDatabase(root, index, data.database, {}, data)
    if (!database) {
        if (method === 'read' || method === 'delete') return data.array = []
        throw new Error(`Database not found: ${data.database}`)
    }
    const view = record => identify({ ...record, $storage: ['db'], $database: [database.name] }, fileId(record))
    if (method === 'read') return data.array = applyReadFilter((await readRecords(index, database._id, ARRAY_CATALOG,
        uuid => arrayMetadataPath(root, database._id, uuid))).map(view), data, { database: data.database, array: ARRAY_CATALOG })
    const names = data.array === undefined ? [] : Array.isArray(data.array) ? data.array : [data.array]
    if (method === 'create' && !names.length) throw new TypeError('array.create requires an array name')
    const results = []
    for (const value of names) {
        const record = method === 'create' ? await ensureArray(root, index, database, value, data.config, data) : await find(root, index, database, name(value))
        if (!record) {
            if (method === 'delete') continue
            throw new Error(`Array not found: ${value}`)
        }
        if (method === 'update') {
            const renamed = name(data.name ?? data.newName ?? record.name)
            if (data.config === undefined && renamed === record.name) throw new Error('array.update requires a new name or config')
            const collision = await find(root, index, database, renamed)
            if (collision && collision._id !== record._id) throw new Error(`Array already exists: ${renamed}`)
            await updateRecord(index, database._id, ARRAY_CATALOG, arrayMetadataPath(root, database._id, fileId(record)), record, current => {
                current.name = renamed
                if (data.config) Object.assign(current.config, data.config)
                current.updated = auditMetadata(data)
            })
        }
        if (method === 'delete') {
            for await (const entry of index.scan(database._id, record._id, '_id', { type: 'string' })) await rm(objectPath(root, database._id, record._id, entry.objectId), { force: true })
            await index.drop(database._id, record._id)
            await adjustDatabaseLengths(root, index, database._id, { arrays: -1, objects: -record.length }, data)
            await deleteRecord(index, database._id, ARRAY_CATALOG, arrayMetadataPath(root, database._id, fileId(record)), record)
        }
        results.push(view(record))
    }
    if (!['create', 'update', 'delete'].includes(method)) throw new Error(`Unsupported CRUD method: array.${method}`)
    return data.array = results
}
