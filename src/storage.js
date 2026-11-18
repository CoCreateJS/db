import { link, rename, writeFile } from 'node:fs/promises'
import { mkdir, unlink } from './io.js'
import { persistenceFor, sendArtifactPath } from './persistence.js'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readMemoryJSON, writeMemoryJSON, memoryOnly, peekMemoryJSON } from './memory.js'

import { live } from './mutation.js'
import { recordFileBytes, flushFileBytes } from './bytes.js'
import { recordPath, stableId } from './files.js'
import { stringifyValue } from './codec.js'
import { encode } from '@cocreate/coson'
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
    value === undefined ? 'undefined' :
        Array.isArray(value) ? 'array' :
            typeof value === 'object' ? 'object' :
    typeof value === 'boolean' ? 'boolean' :
        typeof value === 'string' ? 'string' :
            typeof value === 'number' && Number.isFinite(value) ? 'number' : null

const binaryDescriptorKeys = new Set([
    '$ArrayBuffer', '$Int8Array', '$Uint8Array', '$Uint8ClampedArray',
    '$Int16Array', '$Uint16Array', '$Int32Array', '$Uint32Array',
    '$Float16Array', '$Float32Array', '$Float64Array', '$BigInt64Array',
    '$BigUint64Array', '$DataView', '$Buffer'
])

function isBinaryMetadata(value) {
    return Array.isArray(value) && value.length > 0 && value.every(entry => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
        const keys = Object.keys(entry)
        return keys.length === 1 && binaryDescriptorKeys.has(keys[0]) && entry[keys[0]] instanceof Uint8Array
    })
}

export function objectPath(root, databaseId, arrayId, objectId) {
    return recordPath(root, 'objects', objectId)
}

export async function readJSON(file) {
    const artifact = await sendArtifactPath(file, 'read')
    if (artifact.handled) return artifact.value
    return readMemoryJSON(file)
}

export function pathParts(path) {
    if (typeof path !== 'string' || !path) throw new TypeError('A non-empty property path is required')
    const parts = []
    const pattern = /(?:^|\.)([^.[\]]+)|\[(\d+)\]/g
    let end = 0, match
    while ((match = pattern.exec(path))) {
        if (match.index !== end) throw new TypeError(`Invalid object key path: ${path}`)
        parts.push(match[2] === undefined ? match[1] : Number(match[2]))
        end = pattern.lastIndex
    }
    if (end !== path.length || !parts.length || parts.some(key => typeof key === 'string' && (!key || ['__proto__', 'prototype', 'constructor'].includes(key))))
        throw new TypeError(`Invalid object key path: ${path}`)
    return parts
}

export function getPath(object, path) {
    return pathParts(path).reduce((value, key) => value?.[key], object)
}

export function setPath(object, path, value) {
    const keys = pathParts(path)

    let target = object

    for (let i = 0; i < keys.length - 1; i++) {
        const key = keys[i]
        const nextIsIndex = typeof keys[i + 1] === 'number'
        if (!target[key] || typeof target[key] !== 'object' || (nextIsIndex && !Array.isArray(target[key])) || (!nextIsIndex && Array.isArray(target[key])))
            target[key] = nextIsIndex ? [] : {}
        target = target[key]
    }

    target[keys.at(-1)] = live(value)
}

export function normalizeObject(input) {
    for (const key of Object.keys(input)) {
        if (key.startsWith('$') && key !== '$bytes') { delete input[key]; continue }
        if (key.includes('.') || key.includes('[')) pathParts(key)
    }
    for (const key of Object.keys(input)) if (key.includes('.') || key.includes('[')) {
        const value = input[key]
        delete input[key]
        setPath(input, key, value)
    }
    return input
}

export function normalizeArrayContinuity(value, seen = new WeakSet()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return value
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value
    seen.add(value)
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
            if (!Object.hasOwn(value, i)) value[i] = undefined
            normalizeArrayContinuity(value[i], seen)
        }
    } else {
        for (const key of Object.keys(value)) normalizeArrayContinuity(value[key], seen)
    }
    return value
}

export function flattenIndexValues(object, prefix = '', entries = []) {
    const add = (path, value) => {
        entries.push([`${EXISTS_INDEX_PREFIX}${path}`, true], [path, value])
        if (Array.isArray(value)) {
            normalizeArrayContinuity(value)
            for (let i = 0; i < value.length; i++) add(`${path}[${i}]`, value[i])
        } else if (value && typeof value === 'object' && !ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer)) {
            const ownsBinaryMetadata = isBinaryMetadata(value.binary)
            for (const [key, child] of Object.entries(value)) {
                if (key.startsWith('$') || key === 'binary' && isBinaryMetadata(child)) continue
                if (ownsBinaryMetadata && typeof child === 'string' && /^binary\[(0|[1-9]\d*)\]$/.test(child)) continue
                add(`${path}.${key}`, child)
            }
        }
    }
    const ownsBinaryMetadata = isBinaryMetadata(object?.binary)
    for (const [key, value] of Object.entries(object ?? {})) {
        if (!prefix && key === 'uuid' || key.startsWith('$') || key === 'binary' && isBinaryMetadata(value)) continue
        if (ownsBinaryMetadata && typeof value === 'string' && /^binary\[(0|[1-9]\d*)\]$/.test(value)) continue
        add(prefix ? `${prefix}.${key}` : key, value)
    }
    return entries
}

export async function writeExclusiveJSON(file, value) {
    const artifact = await sendArtifactPath(file, 'create', value)
    if (artifact.handled) return artifact.value
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
        const encoded = file.endsWith('.coson')
            ? encode(value, { operators: false })
            : stringifyValue(value)
        await writeFile(temporary, encoded)
        await link(temporary, file)
        recordFileBytes(file, encoded.byteLength ?? Buffer.byteLength(encoded))
        await flushFileBytes(join(file, '..'))
        writeMemoryJSON(file, value)
    } finally {
        await unlink(temporary).catch(error => {
            if (error.code !== 'ENOENT') throw error
        })
    }
}

export async function replaceJSON(file, value) {
    const artifact = await sendArtifactPath(file, 'replace', value)
    if (artifact.handled) return artifact.value
    if (memoryOnly(file)) return writeMemoryJSON(file, value)
    const store = persistenceFor(file)
    if (store) { store.stageJSON(file, value); return peekMemoryJSON(file) }
    await mkdir(join(file, '..'), { recursive: true })

    const temporary = `${file}.${randomUUID()}.tmp`

    try {
        const encoded = file.endsWith('.coson')
            ? encode(value, { operators: false })
            : stringifyValue(value)
        await writeFile(temporary, encoded)
        await rename(temporary, file)
        recordFileBytes(file, encoded.byteLength ?? Buffer.byteLength(encoded))
        await flushFileBytes(join(file, '..'))
        return writeMemoryJSON(file, value)
    } catch (error) {
        await unlink(temporary).catch(() => {})
        throw error
    }
}
