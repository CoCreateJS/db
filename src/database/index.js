import { rm } from '../io.js'
import { ObjectId } from '@cocreate/utils'
import { DATABASE_CATALOG, DATABASE_CATALOG_ARRAY, ARRAY_CATALOG, arrayMetadataPath,
    auditMetadata, databaseMetadataPath, objectPath } from '../storage.js'
import { createRecord, deleteRecord, findRecordByName, readRecordById, readRecords, updateRecord } from '../records.js'
import { fileId, identify, newFileId } from '../files.js'
import { applyReadFilter } from '../read.js'

const name = value => {
    if (typeof value !== 'string' || !value.trim()) throw new TypeError('database name must be a non-empty string')
    return value
}
const load = (root, index, id) => readRecordById(index, DATABASE_CATALOG, DATABASE_CATALOG_ARRAY, uuid => databaseMetadataPath(root, uuid), id)
const find = (root, index, value) => findRecordByName(index, DATABASE_CATALOG, DATABASE_CATALOG_ARRAY, uuid => databaseMetadataPath(root, uuid), value)

export async function ensureDatabase(root, index, value, config = {}, request = {}) {
    name(value)
    const existing = await find(root, index, value)
    if (existing) return existing
    const id = ObjectId().toString()
    const record = { _id: id, name: value, index: index.catalogId(id, ARRAY_CATALOG), arrayLength: 0, objectLength: 0,
        config, created: auditMetadata(request), updated: auditMetadata(request) }
    await index.ensureCatalog(id, ARRAY_CATALOG)
    return createRecord(index, DATABASE_CATALOG, DATABASE_CATALOG_ARRAY, databaseMetadataPath(root, newFileId()), record)
}

export async function materializeDatabase(root, index, source) {
    name(source?.name)
    const current = await load(root, index, fileId(source))
    if (current) return updateRecord(index, DATABASE_CATALOG, DATABASE_CATALOG_ARRAY, databaseMetadataPath(root, fileId(current)), current, source)
    return createRecord(index, DATABASE_CATALOG, DATABASE_CATALOG_ARRAY, databaseMetadataPath(root, fileId(source)), source)
}

export async function adjustDatabaseLengths(root, index, id, { arrays = 0, objects = 0 }, request = {}) {
    const current = await load(root, index, id)
    if (!current) throw new Error(`Database not found: ${id}`)
    if (current.arrayLength + arrays < 0 || current.objectLength + objects < 0) throw new Error('Database lengths would become invalid')
    return updateRecord(index, DATABASE_CATALOG, DATABASE_CATALOG_ARRAY, databaseMetadataPath(root, fileId(current)), current, value => {
        value.arrayLength += arrays
        value.objectLength += objects
        value.updated = auditMetadata(request)
    })
}

async function view(root, index, record) {
    const arrays = await readRecords(index, record._id, ARRAY_CATALOG, uuid => arrayMetadataPath(root, record._id, uuid))
    // Response containers share the stored config, audit, and child values.
    return identify({ ...record, arrays: arrays.map(array => identify({ ...array, $storage: ['db'], $database: [record.name] }, fileId(array))),
        $storage: ['db'] }, fileId(record))
}

export async function sendDatabase(root, index, method, data) {
    if (method === 'read') {
        const records = await readRecords(index, DATABASE_CATALOG, DATABASE_CATALOG_ARRAY, uuid => databaseMetadataPath(root, uuid))
        const values = []
        for (const record of records) values.push(await view(root, index, record))
        return data.database = applyReadFilter(values, data, { database: DATABASE_CATALOG, array: DATABASE_CATALOG_ARRAY })
    }
    const names = data.database === undefined ? [] : Array.isArray(data.database) ? data.database : [data.database]
    if (method === 'create' && !names.length) throw new TypeError('database.create requires a database name')
    const results = []
    for (const value of names) {
        const current = method === 'create' ? await ensureDatabase(root, index, value, data.config, data) : await find(root, index, name(value))
        if (!current) {
            if (method === 'delete') continue
            throw new Error(`Database not found: ${value}`)
        }
        if (method === 'update') {
            const renamed = name(data.name ?? data.newName ?? current.name)
            if (data.config === undefined && renamed === current.name) throw new Error('database.update requires a new name or config')
            const collision = await find(root, index, renamed)
            if (collision && collision !== current && collision._id !== current._id) throw new Error(`Database already exists: ${renamed}`)
            await updateRecord(index, DATABASE_CATALOG, DATABASE_CATALOG_ARRAY, databaseMetadataPath(root, fileId(current)), current, record => {
                record.name = renamed
                if (data.config) Object.assign(record.config, data.config)
                record.updated = auditMetadata(data)
            })
        }
        const result = await view(root, index, current)
        if (method === 'delete') {
            for (const array of result.arrays) {
                for await (const entry of index.scan(current._id, array._id, '_id', { type: 'string' })) await rm(objectPath(root, current._id, array._id, entry.objectId), { force: true })
                await index.drop(current._id, array._id)
                await rm(arrayMetadataPath(root, current._id, fileId(array)), { force: true })
            }
            await index.drop(current._id, ARRAY_CATALOG)
            await deleteRecord(index, DATABASE_CATALOG, DATABASE_CATALOG_ARRAY, databaseMetadataPath(root, fileId(current)), current)
        }
        results.push(result)
    }
    if (!['create', 'update', 'delete'].includes(method)) throw new Error(`Unsupported CRUD method: database.${method}`)
    return data.database = results
}
