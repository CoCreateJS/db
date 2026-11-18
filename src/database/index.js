import { rm } from '../io.js'
import { ObjectId } from '@cocreate/utils'
import { DATABASE_CATALOG, DATABASE_CATALOG_ARRAY, ARRAY_CATALOG, arrayMetadataPath,
    auditMetadata, databaseMetadataPath, objectPath } from '../storage.js'
import { createRecord, deleteRecord, findRecordByName, readRecordById, readRecords, updateRecord } from '../records.js'
import { fileId, identify, newFileId } from '../files.js'
import { applyReadFilter } from '../read.js'
import { normalizeEntities, entityUuid, hasExplicitFilter } from '../crud.js'

const name = value => {
    if (typeof value !== 'string' || !value.trim()) throw new TypeError('database name must be a non-empty string')
    return value
}
const load = (root, index, id) => readRecordById(index, DATABASE_CATALOG, DATABASE_CATALOG_ARRAY, uuid => databaseMetadataPath(root, uuid), id)
const find = (root, index, value) => findRecordByName(index, DATABASE_CATALOG, DATABASE_CATALOG_ARRAY, uuid => databaseMetadataPath(root, uuid), value)

export async function ensureDatabase(root, index, value, config = {}, request = {}, uuid = newFileId()) {
    name(value)
    const existing = await find(root, index, value)
    if (existing) return existing
    const id = ObjectId().toString()
    const record = { _id: id, name: value, index: index.catalogId(id, ARRAY_CATALOG), arrayLength: 0, objectLength: 0,
        config, created: auditMetadata(request), updated: auditMetadata(request) }
    await index.ensureCatalog(id, ARRAY_CATALOG)
    return createRecord(index, DATABASE_CATALOG, DATABASE_CATALOG_ARRAY, databaseMetadataPath(root, uuid), record)
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
    const inputs = normalizeEntities(data.database, 'database')
    const resolve = async input => {
        const uuid = entityUuid(input, 'database')
        const byUuid = uuid ? await readRecordById(index, DATABASE_CATALOG, DATABASE_CATALOG_ARRAY,
            id => databaseMetadataPath(root, id), uuid) : undefined
        const byName = input.name === undefined ? undefined : await find(root, index, name(input.name))
        if (uuid && input.name !== undefined && (!byUuid || !byName || fileId(byUuid) !== fileId(byName)))
            throw new Error('database.uuid and database.name must resolve to the same database')
        return byUuid ?? byName
    }
    const explicit = []
    for (const input of inputs) {
        if (input.uuid === undefined && input.name === undefined) continue
        const record = await resolve(input)
        if (record && !explicit.some(item => fileId(item) === fileId(record))) explicit.push(record)
    }
    if (method === 'create') {
        if (!inputs.length) return data.database = []
        const results = []
        for (const input of inputs) {
            const databaseName = name(input.name)
            if (await find(root, index, databaseName)) throw new Error(`Database already exists: ${databaseName}`)
            const uuid = entityUuid(input, 'database') ?? newFileId()
            if (await readRecordById(index, DATABASE_CATALOG, DATABASE_CATALOG_ARRAY, id => databaseMetadataPath(root, id), uuid))
                throw new Error(`Database UUID already exists: ${uuid}`)
            results.push(await ensureDatabase(root, index, databaseName, input.config ?? data.config, data, uuid))
        }
        return data.database = await Promise.all(results.map(record => view(root, index, record)))
    }
    let selected = explicit
    if (hasExplicitFilter(data)) {
        const all = await readRecords(index, DATABASE_CATALOG, DATABASE_CATALOG_ARRAY, uuid => databaseMetadataPath(root, uuid))
        const filtered = applyReadFilter(all, data,
            { database: DATABASE_CATALOG, array: DATABASE_CATALOG_ARRAY })
        for (const result of filtered) {
            const record = await readRecordById(index, DATABASE_CATALOG, DATABASE_CATALOG_ARRAY, uuid => databaseMetadataPath(root, uuid), fileId(result))
            if (record && !selected.some(item => fileId(item) === fileId(record))) selected.push(record)
        }
    }
    if (method === 'read') return data.database = await Promise.all(selected.map(record => view(root, index, record)))
    const updatePayload = inputs.find(input => input.name === undefined && input.uuid === undefined)
    if (method === 'update' && hasExplicitFilter(data) && !updatePayload && !data.config && data.name === undefined && data.newName === undefined)
        throw new Error('Filtered database.update requires one unambiguous update payload')
    const results = []
    for (const current of selected) {
        const input = inputs.find(item => (item.uuid && item.uuid.toLowerCase() === fileId(current)) || (item.name && item.name === current.name)) ?? updatePayload ?? {}
        if (method === 'update') {
            const renamed = input.newName === undefined && data.name === undefined && data.newName === undefined
                ? current.name : name(input.newName ?? data.name ?? data.newName)
            const config = input.config ?? data.config
            if (renamed === current.name && config === undefined) throw new Error('database.update requires name or config')
            const collision = await find(root, index, renamed)
            if (collision && fileId(collision) !== fileId(current)) throw new Error(`Database already exists: ${renamed}`)
            await updateRecord(index, DATABASE_CATALOG, DATABASE_CATALOG_ARRAY, databaseMetadataPath(root, fileId(current)), current, record => {
                record.name = renamed
                if (config) Object.assign(record.config, config)
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
