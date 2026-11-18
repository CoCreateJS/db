import { rm } from '../io.js'
import { ObjectId } from '@cocreate/utils'
import { DATABASE_CATALOG, DATABASE_CATALOG_ARRAY, ARRAY_CATALOG, arrayMetadataPath,
    databaseMetadataPath, objectPath, auditMetadata } from '../storage.js'
import { createRecord, deleteRecord, findRecordByName, readRecordById, readRecords, updateRecord } from '../records.js'
import { fileId, identify, newFileId } from '../files.js'
import { ensureDatabase, adjustDatabaseLengths } from '../database/index.js'
import { applyReadFilter } from '../read.js'
import { normalizeEntities, entityUuid, hasExplicitFilter } from '../crud.js'

const name = value => {
    if (typeof value !== 'string' || !value.trim()) throw new TypeError('array name must be a non-empty string')
    return value
}
const find = (root, index, database, value) => findRecordByName(index, database._id, ARRAY_CATALOG, uuid => arrayMetadataPath(root, database._id, uuid), value)

export async function ensureArray(root, index, database, value, config = {}, request = {}, uuid = newFileId()) {
    name(value)
    const existing = await find(root, index, database, value)
    if (existing) return existing
    const id = ObjectId().toString()
    const record = { _id: id, name: value, databaseId: database._id, index: index.catalogId(database._id, id), length: 0,
        config, created: auditMetadata(request), updated: auditMetadata(request) }
    await index.ensureCatalog(database._id, id)
    await createRecord(index, database._id, ARRAY_CATALOG, arrayMetadataPath(root, database._id, uuid), record)
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
    const inputs = normalizeEntities(data.array, 'array')
    const resolve = async input => {
        const uuid = entityUuid(input, 'array')
        const byUuid = uuid ? await readRecordById(index, database._id, ARRAY_CATALOG, id => arrayMetadataPath(root, database._id, id), uuid) : undefined
        const byName = input.name === undefined ? undefined : await find(root, index, database, name(input.name))
        if (uuid && input.name !== undefined && (!byUuid || !byName || fileId(byUuid) !== fileId(byName)))
            throw new Error('array.uuid and array.name must resolve to the same array')
        return byUuid ?? byName
    }
    const selected = []
    for (const input of inputs) {
        if (input.uuid === undefined && input.name === undefined) continue
        const record = await resolve(input)
        if (record && !selected.some(item => fileId(item) === fileId(record))) selected.push(record)
    }
    if (method === 'create') {
        if (!inputs.length) return data.array = []
        const results = []
        for (const input of inputs) {
            const arrayName = name(input.name)
            if (await find(root, index, database, arrayName)) throw new Error(`Array already exists: ${arrayName}`)
            const uuid = entityUuid(input, 'array') ?? newFileId()
            if (await readRecordById(index, database._id, ARRAY_CATALOG, id => arrayMetadataPath(root, database._id, id), uuid))
                throw new Error(`Array UUID already exists: ${uuid}`)
            results.push(await ensureArray(root, index, database, arrayName, input.config ?? data.config, data, uuid))
        }
        return data.array = results.map(view)
    }
    if (hasExplicitFilter(data)) {
        const records = await readRecords(index, database._id, ARRAY_CATALOG, uuid => arrayMetadataPath(root, database._id, uuid))
        for (const result of applyReadFilter(records, data, { database: data.database, array: ARRAY_CATALOG })) {
            const record = await readRecordById(index, database._id, ARRAY_CATALOG, uuid => arrayMetadataPath(root, database._id, uuid), fileId(result))
            if (record && !selected.some(item => fileId(item) === fileId(record))) selected.push(record)
        }
    }
    if (method === 'read') return data.array = selected.map(view)
    const results = []
    const updatePayload = inputs.find(input => input.uuid === undefined && input.name === undefined)
    if (method === 'update' && hasExplicitFilter(data) && !updatePayload && data.name === undefined && data.newName === undefined && data.config === undefined)
        throw new Error('Filtered array.update requires one unambiguous update payload')
    for (const record of selected) {
        if (!record) {
            if (method === 'delete') continue
        }
        const input = inputs.find(item => item.uuid && item.uuid.toLowerCase() === fileId(record) || item.name && item.name === record.name) ?? updatePayload ?? {}
        if (method === 'update') {
            const renamed = name(input.newName ?? data.name ?? data.newName ?? record.name)
            const config = input.config ?? data.config
            if (config === undefined && renamed === record.name) throw new Error('array.update requires a new name or config')
            const collision = await find(root, index, database, renamed)
            if (collision && collision._id !== record._id) throw new Error(`Array already exists: ${renamed}`)
            await updateRecord(index, database._id, ARRAY_CATALOG, arrayMetadataPath(root, database._id, fileId(record)), record, current => {
                current.name = renamed
                if (config) Object.assign(current.config, config)
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
