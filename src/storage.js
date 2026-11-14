import { link, rename, writeFile } from 'node:fs/promises'
import { mkdir, unlink } from './io.js'
import { persistenceFor } from './persistence.js'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readMemoryJSON, writeMemoryJSON, memoryOnly, peekMemoryJSON } from './memory.js'

import { live } from './mutation.js'
import { recordFileBytes, flushFileBytes } from './bytes.js'
import { recordPath, stableId } from './files.js'
export const DATABASE_CATALOG = '__catalog__'
export const DATABASE_CATALOG_ARRAY = 'databases'
export const ARRAY_CATALOG = '__arrays__'
export const EXISTS_INDEX_PREFIX = '\0exists:'

export function auditMetadata(request = {}) {
    const on = request.timeStamp
        ? new Date(request.timeStamp).toISOString()
        : new Date().toISOString()
    const audit = { on }
    const by = request.user_id || request.clientId
    if (by !== undefined) audit.by = by
    return audit
}

const assertId = (id, label) => {
    if (typeof id !== 'string' || !/^[0-9a-f]{24}$/.test(id))
        throw new TypeError(`${label} must be a 24-character hexadecimal ObjectId`)
    return id
}

export function databaseDirectory(root, databaseId) {
    return join(root, 'databases', assertId(databaseId, 'databaseId'))
}

export function arrayDirectory(root, databaseId, arrayId) {
    return join(databaseDirectory(root, databaseId), 'arrays', assertId(arrayId, 'arrayId'))
}

export function databaseMetadataPath(root, databaseId) {
    return recordPath(root, 'databases', databaseId)
}

export function arrayMetadataPath(root, databaseId, arrayId) {
    return recordPath(root, 'arrays', arrayId)
}
export function objectDeletionPath(root, databaseId, arrayId, objectId) {
    return join(root, 'deleted', `${stableId(JSON.stringify([databaseId, arrayId, objectId]))}.json`)
}
export const typeOf = value => value === null ? 'null' :
    typeof value === 'boolean' ? 'boolean' :
        typeof value === 'string' ? 'string' :
            typeof value === 'number' && Number.isFinite(value) ? 'number' : null

export function objectPath(root, databaseId, arrayId, objectId) {
    return recordPath(root, 'objects', objectId)
}

export async function readJSON(file) {
    return readMemoryJSON(file)
}

export function setPath(object, path, value) {
    const keys = path.split('.')

    if (keys.some(key => !key || ['__proto__', 'prototype', 'constructor'].includes(key)))
        throw new TypeError(`Invalid object key path: ${path}`)

    let target = object

    for (const key of keys.slice(0, -1)) {
        if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key]))
            target[key] = {}
        target = target[key]
    }

    target[keys.at(-1)] = live(value)
}

export function normalizeObject(input) {
    for (const key of Object.keys(input)) {
        if (key.startsWith('$') && key !== '$bytes') { delete input[key]; continue }
        if (key.split('.').some(part => ['__proto__', 'prototype', 'constructor'].includes(part)))
            throw new TypeError(`Invalid object key path: ${key}`)
    }
    for (const key of Object.keys(input)) if (key.includes('.')) {
        const value = input[key]
        delete input[key]
        setPath(input, key, value)
    }
    return input
}

export function flattenIndexValues(object, prefix = '', entries = []) {
    for (const [key, value] of Object.entries(object)) {
        if (key.startsWith('$')) continue
        const path = prefix ? `${prefix}.${key}` : key
        if (value === undefined) continue
        entries.push([`${EXISTS_INDEX_PREFIX}${path}`, true])

        if (Array.isArray(value)) entries.push([path, value])
        else if (value && typeof value === 'object')
            flattenIndexValues(value, path, entries)
        else if (typeOf(value))
            entries.push([path, value])
    }

    return entries
}

export async function writeExclusiveJSON(file, value) {
    const store = persistenceFor(file)
    if (store || memoryOnly(file)) {
        if (await readMemoryJSON(file) !== undefined) {
            const error = new Error(`Object already exists: ${file}`)
            error.code = 'EEXIST'
            throw error
        }
        if (store) store.stageJSON(file, value)
        else writeMemoryJSON(file, value)
        return
    }
    await mkdir(join(file, '..'), { recursive: true })

    const temporary = `${file}.${randomUUID()}.tmp`

    try {
        const encoded = JSON.stringify(value)
        await writeFile(temporary, encoded)
        await link(temporary, file)
        recordFileBytes(file, Buffer.byteLength(encoded))
        await flushFileBytes(join(file, '..'))
        writeMemoryJSON(file, value)
    } finally {
        await unlink(temporary).catch(error => {
            if (error.code !== 'ENOENT') throw error
        })
    }
}

export async function replaceJSON(file, value) {
    if (memoryOnly(file)) return writeMemoryJSON(file, value)
    const store = persistenceFor(file)
    if (store) { store.stageJSON(file, value); return peekMemoryJSON(file) }
    await mkdir(join(file, '..'), { recursive: true })

    const temporary = `${file}.${randomUUID()}.tmp`

    try {
        const encoded = JSON.stringify(value)
        await writeFile(temporary, encoded)
        await rename(temporary, file)
        recordFileBytes(file, Buffer.byteLength(encoded))
        await flushFileBytes(join(file, '..'))
        return writeMemoryJSON(file, value)
    } catch (error) {
        await unlink(temporary).catch(() => {})
        throw error
    }
}
