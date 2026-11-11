import { link, mkdir, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const clone = value => structuredClone(value)
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
    return join(databaseDirectory(root, databaseId), 'database.json')
}

export function arrayMetadataPath(root, databaseId, arrayId) {
    return join(arrayDirectory(root, databaseId, arrayId), 'array.json')
}
export const typeOf = value => value === null ? 'null' :
    typeof value === 'boolean' ? 'boolean' :
        typeof value === 'string' ? 'string' :
            typeof value === 'number' && Number.isFinite(value) ? 'number' : null

export const validPathPart = (value, label) => {
    if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[\\/\0]/.test(value))
        throw new TypeError(`${label} must be a non-empty path-safe string`)

    return encodeURIComponent(value)
}

export function objectPath(root, databaseId, arrayId, objectId) {
    return join(
        arrayDirectory(root, databaseId, arrayId),
        'objects',
        `${objectId}.json`
    )
}

export async function readJSON(file) {
    try {
        return JSON.parse(await readFile(file, 'utf8'))
    } catch (error) {
        if (error.code === 'ENOENT') return undefined
        throw error
    }
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

    target[keys.at(-1)] = clone(value)
}

export function normalizeObject(input) {
    const output = {}

    for (const [key, value] of Object.entries(input)) {
        if (key.startsWith('$')) continue
        if (key.split('.').some(part => ['__proto__', 'prototype', 'constructor'].includes(part)))
            throw new TypeError(`Invalid object key path: ${key}`)
        if (key.includes('.')) setPath(output, key, value)
        else output[key] = clone(value)
    }

    return output
}

export function flattenIndexValues(object, prefix = '', entries = []) {
    for (const [key, value] of Object.entries(object)) {
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

export function uniqueIndexEntries(object) {
    const entries = new Map()

    for (const [key, value] of flattenIndexValues(object)) {
        const identity = Array.isArray(value)
            ? JSON.stringify([key, createHash('sha256').update(JSON.stringify(value)).digest('hex')])
            : JSON.stringify([key, value])
        entries.set(identity, [key, value])
    }

    return [...entries.values()]
}

export async function writeExclusiveJSON(file, value) {
    await mkdir(join(file, '..'), { recursive: true })

    const temporary = `${file}.${randomUUID()}.tmp`

    try {
        await writeFile(temporary, JSON.stringify(value))
        await link(temporary, file)
    } finally {
        await unlink(temporary).catch(error => {
            if (error.code !== 'ENOENT') throw error
        })
    }
}

export async function replaceJSON(file, value) {
    await mkdir(join(file, '..'), { recursive: true })

    const temporary = `${file}.${randomUUID()}.tmp`

    try {
        await writeFile(temporary, JSON.stringify(value))
        await rename(temporary, file)
    } catch (error) {
        await unlink(temporary).catch(() => {})
        throw error
    }
}

/** Remove local data while retaining every nested Distributed Index directory. */
export async function removeDirectoryPreservingDistributed(root, directory) {
    const preserved = []

    const collect = async current => {
        let entries
        try {
            entries = await readdir(current, { withFileTypes: true })
        } catch (error) {
            if (error.code === 'ENOENT') return
            throw error
        }

        for (const entry of entries) {
            if (!entry.isDirectory()) continue
            const path = join(current, entry.name)
            if (entry.name === 'distributed') {
                const temporary = join(root, `.distributed-preserve-${randomUUID()}`)
                await rename(path, temporary)
                preserved.push({ path, temporary })
            } else await collect(path)
        }
    }

    try {
        await collect(directory)
        await rm(directory, { recursive: true, force: true })

        for (const { path, temporary } of preserved) {
            await mkdir(join(path, '..'), { recursive: true })
            await rename(temporary, path)
        }
    } catch (error) {
        for (const { path, temporary } of preserved.reverse()) {
            await mkdir(join(path, '..'), { recursive: true }).catch(() => {})
            await rename(temporary, path).catch(() => {})
        }
        throw error
    }
}
