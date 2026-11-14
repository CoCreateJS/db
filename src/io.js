import * as fs from 'node:fs/promises'
import { join, resolve, relative, sep } from 'node:path'
import { persistenceFor } from './persistence.js'
import { memoryEntries, memoryRemoved, removeMemoryPath, memoryOnly, markMemoryRemoval } from './memory.js'

import { removeFileBytes, flushFileBytes } from './bytes.js'
import { forgetResolvedPath } from './resolution.js'

export async function mkdir(path, options) {
    if (!memoryOnly(path) && !persistenceFor(path)) return fs.mkdir(path, options)
}
export async function rm(path, options = {}) {
    forgetResolvedPath(resolve(path), options.recursive)
    const store = persistenceFor(path)
    if (memoryOnly(path)) return markMemoryRemoval(path)
    if (store) return store.remove(path, options)
    await fs.rm(path, options)
    removeFileBytes(path, options)
    await flushFileBytes(join(path, '..'))
    removeMemoryPath(path)
}
export async function unlink(path) {
    if (memoryOnly(path) || persistenceFor(path)) return rm(path, { force: true })
    await fs.unlink(path)
    removeFileBytes(path)
    await flushFileBytes(join(path, '..'))
}
export async function readdir(path, options) {
    if (!memoryOnly(path) && !persistenceFor(path)) return fs.readdir(path, options)
    path = resolve(path)
    const entries = new Map()
    try {
        if (memoryOnly(path)) throw Object.assign(new Error('Memory-only directory'), { code: 'ENOENT' })
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
