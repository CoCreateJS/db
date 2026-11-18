import { readFile } from 'node:fs/promises'
import { sep } from 'node:path'
import { live, replaceLive } from './mutation.js'
import { parseValue, stringifyValue } from './codec.js'
import { decode } from '@cocreate/coson'
import { resolvePath } from './path.js'

const roots = new Set()
const volatileRoots = new Set()
const files = new Map()
const removed = new Set()
const pinned = new Set()
let generation = 0
const inside = (root, file) => file === root || file.startsWith(root + sep)

/** Enable read-through caching without enumerating or reading stored files. */
export function enableMemoryCache(directory, { memoryOnly = false } = {}) {
    roots.add(resolvePath(directory))
    if (memoryOnly) volatileRoots.add(resolvePath(directory))
}

export function memoryOnly(file) {
    file = resolvePath(file)
    for (const root of volatileRoots) if (inside(root, file)) return true
    return false
}

export function memoryEnabled(file) {
    file = resolvePath(file)
    for (const root of roots) if (inside(root, file)) return true
    return false
}

export async function readMemoryJSON(file) {
    file = resolvePath(file)
    if (files.has(file)) return live(files.get(file))
    if (memoryRemoved(file)) return undefined
    if (memoryOnly(file)) return undefined
    const observedGeneration = generation
    try {
        const value = file.endsWith('.coson')
            ? decode(new Uint8Array(await readFile(file)), { operators: false })
            : parseValue(await readFile(file, 'utf8'))
        if (memoryEnabled(file) && observedGeneration === generation) {
            files.set(file, value)
            return live(value)
        }
        return live(value)
    } catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
}

export function writeMemoryJSON(file, value) {
    generation++
    file = resolvePath(file)
    if (memoryEnabled(file)) {
        const previous = files.get(file)
        value = live(value)
        if (previous && value && typeof previous === 'object' && typeof value === 'object' && Array.isArray(previous) === Array.isArray(value))
            value = replaceLive(previous, value)
        files.set(file, value)
        return value
    }
    return live(value)
}

export function removeMemoryPath(path) {
    generation++
    path = resolvePath(path)
    for (const file of files.keys()) if (inside(path, file) && !pinned.has(file)) {
        files.delete(file)
    }
}

export function memoryStats(directory) {
    const root = resolvePath(directory)
    const entries = [...files].filter(([file, value]) => value !== undefined && inside(root, file))
    return { files: entries.length, serializedBytes: entries.reduce((sum, [, value]) => sum + Buffer.byteLength(stringifyValue(value)), 0) }
}

// Cache reads and queued work share the owned value.
export const peekMemoryJSON = file => files.get(resolvePath(file))
export const pinMemoryPath = file => pinned.add(resolvePath(file))
export const unpinMemoryPath = file => pinned.delete(resolvePath(file))
export function memoryEntries(directory) {
    const root = resolvePath(directory)
    return [...files].filter(([file]) => inside(root, file))
}
export function memoryRemoved(file) {
    file = resolvePath(file)
    if (files.has(file)) return files.get(file) === undefined
    for (const path of removed) if (inside(path, file)) return true
    return false
}
export function markMemoryRemoval(path) {
    generation++
    path = resolvePath(path)
    for (const file of files.keys()) if (inside(path, file)) {
        files.delete(file)
    }
    removed.add(path)
    files.set(path, undefined)
}
