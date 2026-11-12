import { rm } from 'node:fs/promises'
import { flattenIndexValues, readJSON, replaceJSON, uniqueIndexEntries, writeExclusiveJSON } from './storage.js'
import { removeMemoryPath } from './memory.js'
import { queryData } from '@cocreate/utils'

export async function createRecord(index, database, array, file, record) {
    const inserted = []
    let wroteRecord = false

    try {
        await writeExclusiveJSON(file, record)
        wroteRecord = true

        for (const [key, value] of flattenIndexValues(record)) {
            await index.set(database, array, key, value, record._id)
            inserted.push([key, value])
        }

        return record
    } catch (error) {
        for (const [key, value] of inserted.reverse())
            await index.remove(database, array, key, value, record._id).catch(() => {})
        if (wroteRecord) { removeMemoryPath(file); await rm(file, { force: true }).catch(() => {}) }
        throw error
    }
}

export async function updateRecord(index, database, array, file, current, updated) {
    const before = uniqueIndexEntries(current)
    const after = uniqueIndexEntries(updated)
    const afterKeys = new Set(after.map(entry => JSON.stringify(entry)))
    const beforeKeys = new Set(before.map(entry => JSON.stringify(entry)))
    const removed = before.filter(entry => !afterKeys.has(JSON.stringify(entry)))
    const added = after.filter(entry => !beforeKeys.has(JSON.stringify(entry)))
    const completedRemovals = []
    const completedAdditions = []

    try {
        for (const [key, value] of removed) {
            if (await index.remove(database, array, key, value, current._id))
                completedRemovals.push([key, value])
        }

        for (const [key, value] of added) {
            await index.set(database, array, key, value, current._id)
            completedAdditions.push([key, value])
        }

        await replaceJSON(file, updated)
        return updated
    } catch (error) {
        for (const [key, value] of completedAdditions.reverse())
            await index.remove(database, array, key, value, current._id).catch(() => {})
        for (const [key, value] of completedRemovals)
            await index.set(database, array, key, value, current._id).catch(() => {})
        throw error
    }
}

export async function deleteRecord(index, database, array, file, record) {
    const removed = []

    try {
        for (const [key, value] of uniqueIndexEntries(record)) {
            if (await index.remove(database, array, key, value, record._id))
                removed.push([key, value])
        }

        removeMemoryPath(file)
        await rm(file)
        return record
    } catch (error) {
        for (const [key, value] of removed)
            await index.set(database, array, key, value, record._id).catch(() => {})
        throw error
    }
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
