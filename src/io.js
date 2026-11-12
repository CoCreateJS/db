import * as fs from 'node:fs/promises'
import { join, resolve, relative, sep } from 'node:path'
import { persistenceFor } from './persistence.js'
import { memoryEntries, memoryRemoved, removeMemoryPath } from './memory.js'

export async function mkdir(path, options) {
    if (!persistenceFor(path)) return fs.mkdir(path, options)
}
export async function rm(path, options = {}) {
    const store = persistenceFor(path)
    if (store) return store.remove(path, options)
    await fs.rm(path, options)
    removeMemoryPath(path)
}
export async function unlink(path) {
    if (persistenceFor(path)) return rm(path, { force: true })
    return fs.unlink(path)
}
export async function readdir(path, options) {
    if (!persistenceFor(path)) return fs.readdir(path, options)
    path = resolve(path)
    const entries = new Map()
    try {
        for (const entry of await fs.readdir(path, { withFileTypes: true }))
            if (!memoryRemoved(join(path, entry.name))) entries.set(entry.name, entry)
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    for (const [file, value] of memoryEntries(path)) {
        if (value === undefined) continue
        const parts = relative(path, file).split(sep)
        const name = parts[0]
        if (!name) continue
        entries.set(name, { name, isDirectory: () => parts.length > 1, isFile: () => parts.length === 1 })
    }
    return options?.withFileTypes ? [...entries.values()] : [...entries.keys()]
}
