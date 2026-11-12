import { readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

const roots = new Set()
const files = new Map()
const inside = (root, file) => file === root || file.startsWith(root + sep)

/** Enable read-through caching without enumerating or reading stored files. */
export function enableMemoryCache(directory) {
    roots.add(resolve(directory))
}

export function memoryEnabled(file) {
    file = resolve(file)
    for (const root of roots) if (inside(root, file)) return true
    return false
}

export async function readMemoryJSON(file) {
    file = resolve(file)
    if (files.has(file)) return structuredClone(files.get(file))
    try {
        const value = JSON.parse(await readFile(file, 'utf8'))
        if (memoryEnabled(file)) {
            files.set(file, value)
            // The first caller must not receive the object retained by the cache.
            return structuredClone(value)
        }
        return value
    } catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
}

export function writeMemoryJSON(file, value) {
    file = resolve(file)
    if (memoryEnabled(file)) files.set(file, structuredClone(value))
}

export function removeMemoryPath(path) {
    path = resolve(path)
    for (const file of files.keys()) if (inside(path, file)) files.delete(file)
}

export function memoryStats(directory) {
    const root = resolve(directory)
    const entries = [...files].filter(([file]) => inside(root, file))
    return { files: entries.length, serializedBytes: entries.reduce((sum, [, value]) => sum + Buffer.byteLength(JSON.stringify(value)), 0) }
}
