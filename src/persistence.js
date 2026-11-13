import * as fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, resolve, sep, relative } from 'node:path'
import { enableMemoryCache, peekMemoryJSON, writeMemoryJSON, markMemoryRemoval, pinMemoryPath, unpinMemoryPath, memoryEntries, memoryState, restoreMemoryState } from './memory.js'

import { recordFileBytes, removeFileBytes, flushFileBytes } from './bytes.js'

const stores = new Map()
const inside = (root, path) => path === root || path.startsWith(root + sep)
export function persistenceFor(path) {
    path = resolve(path)
    for (const [root, store] of stores) if (inside(root, path)) return store
}

/** One sequential write-behind queue. Entries retain addresses, never serialized transactions. */
export function createPersistence({ directory, canFlush = () => true, storage, write, retryMs = 1000, debounceMs = 25, maxWaitMs = 1000 }) {
    if (![retryMs, debounceMs, maxWaitMs].every(value => Number.isFinite(value) && value >= 0) || maxWaitMs < debounceMs)
        throw new TypeError('Persistence delays must be finite non-negative numbers; maxWaitMs must cover debounceMs')
    const root = resolve(directory)
    if (stores.has(root)) throw new Error(`Persistence already initialized for ${root}`)
    enableMemoryCache(root)
    const dirty = new Map()
    let revision = 0, holds = 0, running, timer, closed = false, lastError, checkpoint
    const schedule = delay => {
        if (closed || timer || running || holds || !dirty.size || !canFlush()) return
        if (delay === undefined) {
            let earliest = Infinity
            for (const entry of dirty.values()) earliest = Math.min(earliest, entry.dueAt)
            delay = Math.max(0, earliest - Date.now())
        }
        timer = setTimeout(() => {
            timer = undefined
            flush(false).catch(error => {
                lastError = error
                schedule(retryMs)
            })
        }, delay)
        timer.unref?.()
    }
    const capture = path => {
        if (checkpoint && !checkpoint.has(path)) checkpoint.set(path, { memory: memoryState(path), dirty: dirty.get(path) })
    }
    const stage = (path, operation, options = {}) => {
        if (closed) throw new Error('Persistence is closed')
        path = resolve(path)
        if (operation === 'remove' && options.recursive) {
            for (const key of dirty.keys()) if (inside(path, key)) { dirty.delete(key); unpinMemoryPath(key) }
        }
        const firstDirty = dirty.get(path)?.firstDirty ?? Date.now()
        const dueAt = Math.min(Date.now() + debounceMs, firstDirty + maxWaitMs)
        dirty.set(path, { revision: ++revision, operation, options, firstDirty, dueAt })
        pinMemoryPath(path)
        schedule()
    }
    const writeDisk = write ?? (async ({ path, operation, value, options }) => {
        if (operation === 'remove') {
            await fs.rm(path, { ...options, force: true })
            removeFileBytes(path, options)
            return
        }
        await fs.mkdir(dirname(path), { recursive: true })
        const temp = `${path}.${randomUUID()}.tmp`
        try {
            const encoded = JSON.stringify(value)
            await fs.writeFile(temp, encoded)
            await fs.rename(temp, path)
            recordFileBytes(path, Buffer.byteLength(encoded))
        } finally { await fs.rm(temp, { force: true }) }
    })
    async function flush(force = true) {
        if (running) {
            await running
            if (force && dirty.size) return flush(true)
            return
        }
        if (holds || !canFlush()) {
            if (force) throw new Error('Indexing or a memory transaction is still pending')
            return
        }
        if (timer) { clearTimeout(timer); timer = undefined }
        running = (async () => {
            while (dirty.size && !holds && canFlush()) {
                let eligible
                for (const [path, entry] of dirty) {
                    if (!force && entry.dueAt > Date.now()) continue
                    let blocked = false
                    for (let parent = dirname(path); inside(root, parent); parent = dirname(parent)) {
                        const ancestor = dirty.get(parent)
                        if (ancestor?.operation === 'remove' && ancestor.options.recursive) { blocked = true; break }
                        if (parent === root) break
                    }
                    if (!blocked) { eligible = [path, entry]; break }
                }
                if (!eligible) break
                const [path, entry] = eligible
                // Cache values are immutable snapshots; replacement while awaiting I/O
                // leaves this revision stable and keeps the newer revision dirty.
                const value = peekMemoryJSON(path)
                const item = { path, ...entry, value }
                await writeDisk(item)
                if (storage) await storage({ ...item, path: relative(root, path).split(sep).join('/'), value: structuredClone(value) })
                if (dirty.get(path) === entry) { dirty.delete(path); unpinMemoryPath(path) }
                lastError = undefined
            }
            await flushFileBytes(root)
        })()
        try { await running }
        catch (error) { lastError = error; throw error }
        finally {
            running = undefined
            schedule(lastError ? retryMs : undefined)
        }
    }
    const store = {
        root,
        stageJSON(path, value) { path = resolve(path); capture(path); writeMemoryJSON(path, value); stage(path, 'set') },
        remove(path, options) {
            path = resolve(path)
            capture(path)
            for (const [file] of memoryEntries(path)) capture(file)
            for (const file of dirty.keys()) if (inside(path, file)) capture(file)
            markMemoryRemoval(path)
            stage(path, 'remove', options)
        },
        checkpoint() {
            if (checkpoint) throw new Error('Nested persistence checkpoint')
            const undo = checkpoint = new Map()
            const release = store.hold()
            return {
                commit() { checkpoint = undefined; release() },
                rollback() {
                    checkpoint = undefined
                    for (const [path, before] of undo) {
                        restoreMemoryState(path, before.memory)
                        if (before.dirty) { dirty.set(path, before.dirty); pinMemoryPath(path) }
                        else { dirty.delete(path); unpinMemoryPath(path) }
                    }
                    release()
                }
            }
        },
        hold() { holds++; return () => { holds--; schedule() } },
        schedule,
        flush,
        stats: () => ({ pending: dirty.size, writing: Boolean(running), error: lastError?.message }),
        async close() {
            await flush()
            if (dirty.size) throw new Error('Persistence still has pending writes')
            closed = true
            if (timer) clearTimeout(timer)
            stores.delete(root)
        }
    }
    stores.set(root, store)
    return store
}
