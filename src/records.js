import { rm } from './io.js'
import { flattenIndexValues, normalizeArrayContinuity, readJSON, replaceJSON, writeExclusiveJSON } from './storage.js'
import { removeMemoryPath } from './memory.js'
import { queryData } from '@cocreate/utils'
import { indexEntries, entryKey } from './entries.js'
import { replaceLive, live } from './mutation.js'
import { fileId, fileIdFromPath, identify } from './files.js'
import { currentResolution, resolvedCatalog, retainRecord, forgetResolvedPath } from './resolution.js'

export async function createRecord(index, database, array, file, record) {
    normalizeArrayContinuity(record)
    identify(record, fileIdFromPath(file))
    await writeExclusiveJSON(file, record)
    const createIndexes = async () => {
        for (const [key, value] of flattenIndexValues(record))
            await index.create(database, array, key, value, fileId(record))
    }
    if (index.batch) await index.batch(createIndexes)
    else await createIndexes()
    const retained = retainRecord(index, database, array, file, record)
    index.artifacts?.set(fileId(record), retained)
    return retained
}

export async function updateRecord(index, database, array, file, current, updated) {
    const before = indexEntries(current)
    forgetResolvedPath(file)
    if (typeof updated === 'function') updated(current)
    else replaceLive(current, updated)
    normalizeArrayContinuity(current)
    await reconcileEntrySets(index, database, array, fileId(current), before, indexEntries(current))
    await replaceJSON(file, current)
    const retained = retainRecord(index, database, array, file, live(current))
    index.artifacts?.set(fileId(current), retained)
    return retained
}

export async function reconcileEntrySets(index, database, array, objectId, before, after) {
    const reconcile = async () => {
        const afterKeys = new Set(after.map(entryKey))
        const beforeKeys = new Set(before.map(entryKey))
        for (const entry of before) if (!afterKeys.has(entryKey(entry)))
            await index.removeIndexed(database, array, entry, objectId)
        for (const entry of after) if (!beforeKeys.has(entryKey(entry)))
            await index.create(database, array, entry.key, entry.value, objectId)
    }
    if (index.batch) await index.batch(reconcile)
    else await reconcile()
}

export async function deleteRecord(index, database, array, file, record) {
    const removeIndexes = async () => {
        for (const entry of indexEntries(record))
            await index.removeIndexed(database, array, entry, fileId(record))
    }
    if (index.batch) await index.batch(removeIndexes)
    else await removeIndexes()
    index.artifacts?.delete(fileId(record))
    removeMemoryPath(file)
    await rm(file)
    return record
}

export async function recordReference(index, database, array, id) {
    if (typeof id !== 'string') return undefined
    if (/^[a-f0-9]{32}$/i.test(id)) return id
    const catalog = resolvedCatalog(index, database, array)
    if (catalog?.ids[id]) return catalog.ids[id]
    for await (const entry of index.scan(database, array, '_id', { type: 'string', lower: id, upper: id }))
        if (entry.value === id) {
            if (catalog) catalog.ids[id] = entry.objectId
            return entry.objectId
        }
}

export async function readRecordById(index, database, array, fileForId, id) {
    const uuid = await recordReference(index, database, array, id)
    if (!uuid) return undefined
    const artifact = index.artifacts?.get(uuid)
    if (artifact) return artifact
    const file = fileForId(uuid)
    const cached = currentResolution()?.files[file]
    if (cached) return cached
    const record = await readJSON(file)
    if (!record) return undefined
    identify(record, uuid)
    const retained = retainRecord(index, database, array, file, record)
    index.artifacts?.set(uuid, retained)
    return retained
}

export async function findRecordByName(index, database, array, fileForId, name) {
    const record = resolvedCatalog(index, database, array)?.names[name]
    if (record) return record
    for await (const entry of index.scan(database, array, 'name', { type: 'string', lower: name, upper: name })) {
        if (entry.value !== name) continue
        return readRecordById(index, database, array, fileForId, entry.objectId)
    }
}

export async function readRecords(index, database, array, fileForId, query = {}) {
    const records = []

    for await (const entry of index.scan(database, array, '_id', { type: 'string' })) {
        const record = await readRecordById(index, database, array, fileForId, entry.objectId)
        if (record && queryData(record, query)) records.push(record)
    }

    return records
}
