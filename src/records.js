import { rm } from './io.js'
import { flattenIndexValues, readJSON, replaceJSON, writeExclusiveJSON } from './storage.js'
import { removeMemoryPath } from './memory.js'
import { queryData } from '@cocreate/utils'
import { indexEntries, entryKey } from './entries.js'
import { replaceLive, live } from './mutation.js'

export async function createRecord(index, database, array, file, record) {
    await writeExclusiveJSON(file, record)
    for (const [key, value] of flattenIndexValues(record))
        await index.set(database, array, key, value, record._id)
    return record
}

export async function updateRecord(index, database, array, file, current, updated) {
    const before = indexEntries(current)
    replaceLive(current, updated)
    await reconcileEntrySets(index, database, array, current._id, before, indexEntries(current))
    await replaceJSON(file, current)
    return live(current)
}

export async function reconcileRecordIndexes(index, database, array, current, updated) {
    return reconcileEntrySets(index, database, array, updated?._id ?? current?._id,
        indexEntries(current), indexEntries(updated))
}

export async function reconcileEntrySets(index, database, array, objectId, before, after) {
    const afterKeys = new Set(after.map(entryKey))
    const beforeKeys = new Set(before.map(entryKey))
    for (const entry of before) if (!afterKeys.has(entryKey(entry)))
        await index.removeIndexed(database, array, entry, objectId)
    for (const entry of after) if (!beforeKeys.has(entryKey(entry)))
        await index.set(database, array, entry.key, entry.value, objectId)
}

export async function deleteRecord(index, database, array, file, record) {
    for (const entry of indexEntries(record))
        await index.removeIndexed(database, array, entry, record._id)
    removeMemoryPath(file)
    await rm(file)
    return record
}

export async function readRecordById(index, database, array, fileForId, id) {
    if (typeof id !== 'string') return undefined
    const record = await readJSON(fileForId(id))
    return record?._id === id ? record : undefined
}

export async function findRecordByName(index, database, array, fileForId, name) {
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
