import { readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { live, replaceLive } from './mutation.js'

const roots = new Set()
const volatileRoots = new Set()
const files = new Map()
const removed = new Set()
const pinned = new Set()
let generation = 0
const inside = (root, file) => file === root || file.startsWith(root + sep)

/** Enable read-through caching without enumerating or reading stored files. */
export function enableMemoryCache(directory, { memoryOnly = false } = {}) {
    roots.add(resolve(directory))
    if (memoryOnly) volatileRoots.add(resolve(directory))
}

export function memoryOnly(file) {
    file = resolve(file)
    for (const root of volatileRoots) if (inside(root, file)) return true
    return false
}

export function memoryEnabled(file) {
    file = resolve(file)
    for (const root of roots) if (inside(root, file)) return true
    return false
}

export async function readMemoryJSON(file) {
    file = resolve(file)
    if (files.has(file)) return live(files.get(file))
    if (memoryRemoved(file)) return undefined
    if (memoryOnly(file)) return undefined
    const observedGeneration = generation
    try {
        const value = JSON.parse(await readFile(file, 'utf8'))
        if (memoryEnabled(file) && observedGeneration === generation) {
            files.set(file, value)
            return live(value)
        }
        return live(value)
    } catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
}

export function writeMemoryJSON(file, value) {
    generation++
    file = resolve(file)
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
    path = resolve(path)
    for (const file of files.keys()) if (inside(path, file) && !pinned.has(file)) {
        files.delete(file)
    }
}

export function memoryStats(directory) {
    const root = resolve(directory)
    const entries = [...files].filter(([file, value]) => value !== undefined && inside(root, file))
    return { files: entries.length, serializedBytes: entries.reduce((sum, [, value]) => sum + Buffer.byteLength(JSON.stringify(value)), 0) }
}

// Cache reads and queued work share the owned value.
export const peekMemoryJSON = file => files.get(resolve(file))
export const pinMemoryPath = file => pinned.add(resolve(file))
export const unpinMemoryPath = file => pinned.delete(resolve(file))
export function memoryEntries(directory) {
    const root = resolve(directory)
    return [...files].filter(([file]) => inside(root, file))
}
export function memoryRemoved(file) {
    file = resolve(file)
    if (files.has(file)) return files.get(file) === undefined
    for (const path of removed) if (inside(path, file)) return true
    return false
}
export function markMemoryRemoval(path) {
    generation++
    path = resolve(path)
    for (const file of files.keys()) if (inside(path, file)) {
        files.delete(file)
    }
    removed.add(path)
    files.set(path, undefined)
}

export function memoryState(file) {
    file = resolve(file)
    return { present: files.has(file), value: files.get(file), removed: removed.has(file) }
}
export function restoreMemoryState(file, state) {
    file = resolve(file)
    if (state.present) files.set(file, state.value)
    else files.delete(file)
    if (state.removed) removed.add(file)
    else removed.delete(file)
}
