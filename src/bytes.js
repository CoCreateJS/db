import * as fs from 'node:fs/promises'
import { dirname, basename, join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

// Node-local bookkeeping. Never indexed, replicated, or used for splitting.
// One sidecar per directory; a persistence pass writes each changed sidecar once.
const pending = new Map()
let queue = Promise.resolve()
const inside = (root, path) => path === root || path.startsWith(root + sep)
export function recordFileBytes(file, bytes) {
    file = resolve(file)
    if (!file.endsWith('.json')) return
    const directory = dirname(file)
    if (!pending.has(directory)) pending.set(directory, new Map())
    pending.get(directory).set(basename(file), bytes)
}
export function removeFileBytes(path, { recursive = false } = {}) {
    path = resolve(path)
    if (recursive) for (const directory of pending.keys()) if (inside(path, directory)) pending.delete(directory)
    recordFileBytes(path, null)
}
export function flushFileBytes(root) {
    root = resolve(root)
    const result = queue.then(async () => {
        for (const [directory, changes] of pending) {
            if (!inside(root, directory)) continue
            const batch = new Map(changes)
            const sidecar = join(directory, '.bytes')
            let sizes
            try { sizes = JSON.parse(await fs.readFile(sidecar, 'utf8')) }
            catch (error) { if (error.code !== 'ENOENT') throw error; sizes = {} }
            for (const [file, bytes] of batch) {
                if (bytes === null) delete sizes[file]
                else sizes[file] = bytes
            }
            const temporary = `${sidecar}.${randomUUID()}.tmp`
            try {
                // A deleted directory must never be recreated by accounting.
                await fs.writeFile(temporary, JSON.stringify(sizes))
                await fs.rename(temporary, sidecar)
            } catch (error) { if (error.code !== 'ENOENT') throw error }
            finally { await fs.rm(temporary, { force: true }) }
            for (const [file, bytes] of batch) if (changes.get(file) === bytes) changes.delete(file)
            if (!changes.size) pending.delete(directory)
        }
    })
    queue = result.catch(() => {})
    return result
}
