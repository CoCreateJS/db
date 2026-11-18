import * as fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join, sep, relative } from 'node:path'
import { enableMemoryCache, memoryEnabled, peekMemoryJSON, readMemoryJSON, writeMemoryJSON, markMemoryRemoval, pinMemoryPath, unpinMemoryPath } from './memory.js'
import { deleteArtifact, getArtifact, getOrganization, hasArtifact, setArtifact, setOrganization } from './organization.js'

import { recordFileBytes, removeFileBytes, flushFileBytes } from './bytes.js'
import { stringifyValue } from './codec.js'
import { encode } from '@cocreate/coson'
import { resolvePath } from './path.js'

const stores = new Map()
const inside = (root, path) => path === root || path.startsWith(root + sep)
export function persistenceFor(path) {
    path = resolvePath(path)
    for (const [root, store] of stores) if (inside(root, path)) return store
}

export function artifactAddress(path) {
    const parts = resolvePath(path).split(sep)
    for (let index = 1; index < parts.length - 1; index++) {
        const organization_id = parts[index - 1]
        const artifactId = parts[index + 1].replace(/\.coson$/, '')
        if (parts[index] === 'data' && /^[a-f0-9]{24}$/i.test(organization_id) &&
            /^[a-f0-9]{32}$/i.test(artifactId) && index === parts.length - 2)
            return { organization_id, artifactId }
    }
}

/** Keep UUID-addressed organization records in the shared artifact map. */
export async function sendArtifactPath(path, operation, value) {
    const address = artifactAddress(path)
    if (!address) return { handled: false }
    const store = persistenceFor(path)
    if (store) {
        const request = { organization_id: address.organization_id, artifactId: address.artifactId, value }
        if (operation === 'replace') {
            const updated = await store.send({ ...request, method: 'persistence.update' })
            return { handled: true, value: updated === undefined
                ? await store.send({ ...request, method: 'persistence.create' }) : updated }
        }
        return { handled: true, value: await store.send({ ...request, method: `persistence.${operation}` }) }
    }

    const pathValue = resolvePath(path)
    if (!memoryEnabled(pathValue)) return { handled: false }
    const { organization_id, artifactId } = address
    if (operation === 'read') {
        if (hasArtifact(organization_id, artifactId)) return { handled: true, value: getArtifact(organization_id, artifactId) }
        const artifact = await readMemoryJSON(pathValue)
        if (artifact !== undefined) setArtifact(organization_id, artifactId, artifact)
        return { handled: true, value: artifact }
    }
    if (operation === 'delete') {
        deleteArtifact(organization_id, artifactId)
        markMemoryRemoval(pathValue)
        return { handled: true, value: true }
    }
    if (operation === 'create' && (hasArtifact(organization_id, artifactId) || await readMemoryJSON(pathValue) !== undefined)) {
        const error = new Error(`Artifact already exists: ${artifactId}`)
        error.code = 'EEXIST'
        throw error
    }
    if (operation === 'update' && !hasArtifact(organization_id, artifactId)) {
        const existing = await readMemoryJSON(pathValue)
        if (existing === undefined) return { handled: true, value: undefined }
        setArtifact(organization_id, artifactId, existing)
    }
    setArtifact(organization_id, artifactId, value)
    writeMemoryJSON(pathValue, value)
    return { handled: true, value }
}

/** One sequential write-behind queue. Entries retain addresses, never serialized transactions. */
export function createPersistence({ directory, canFlush = () => true, storage, write, retryMs = 1000, debounceMs = 25, maxWaitMs = 1000 }) {
    if (![retryMs, debounceMs, maxWaitMs].every(value => Number.isFinite(value) && value >= 0) || maxWaitMs < debounceMs)
        throw new TypeError('Persistence delays must be finite non-negative numbers; maxWaitMs must cover debounceMs')
    const root = resolvePath(directory)
    if (stores.has(root)) throw new Error(`Persistence already initialized for ${root}`)
    enableMemoryCache(root)
        const artifactPath = (organization_id, artifactId) => {
        if (typeof organization_id !== 'string' || !organization_id || /[\\/\0]/.test(organization_id))
            throw new TypeError('A path-safe organization_id is required')
        if (!/^[a-f0-9]{32}$/i.test(artifactId)) throw new TypeError('Artifact ID must be a UUID')
        return join(root, organization_id, 'data', `${artifactId}.coson`)
    }
    const dirty = new Map()
    let revision = 0, holds = 0, running, timer, closed = false, lastError
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
    const stage = (path, operation, options = {}) => {
        if (closed) throw new Error('Persistence is closed')
        path = resolvePath(path)
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
            const encoded = path.endsWith('.coson')
                ? encode(value, { operators: false })
                : stringifyValue(value)
            await fs.writeFile(temp, encoded)
            await fs.rename(temp, path)
            recordFileBytes(path, encoded.byteLength ?? Buffer.byteLength(encoded))
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
                // Keep the DB-owned value reference. Encoders own serialization;
                // a newer staged revision must remain dirty after this acknowledgment.
                const value = peekMemoryJSON(path)
                const item = { path, ...entry, value }
                await writeDisk(item)
                if (storage) await storage({ ...item, path: relative(root, path).split(sep).join('/'), value })
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
        async send(request = {}) {
            const [scope, operation] = String(request.method ?? '').split('.')
            const organization_id = request.organization_id
            if (typeof organization_id !== 'string' || !/^[a-f0-9]{24}$/i.test(organization_id))
                throw new TypeError('organization_id must be a 24-character hexadecimal ID')
            if (scope === 'organization') {
                if (operation === 'get') return getOrganization(organization_id)
                if (operation === 'set') return setOrganization(organization_id, request.root)
                if (operation === 'read') {
                    const path = join(root, organization_id, 'index.json')
                    const value = await readMemoryJSON(path)
                    if (value === undefined) return undefined
                    return setOrganization(organization_id, value)
                }
                if (operation === 'write') {
                    const path = join(root, organization_id, 'index.json')
                    const value = setOrganization(organization_id, request.root)
                    writeMemoryJSON(path, value)
                    stage(path, 'set')
                    return value
                }
                throw new TypeError(`Unsupported persistence method: ${request.method}`)
            }
            if (scope !== 'persistence' || !['create', 'read', 'update', 'delete'].includes(operation))
                throw new TypeError(`Unsupported persistence method: ${request.method}`)
            const path = artifactPath(organization_id, request.artifactId)
            if (operation === 'read') {
                if (hasArtifact(organization_id, request.artifactId)) return getArtifact(organization_id, request.artifactId)
                const value = await readMemoryJSON(path)
                if (value !== undefined) setArtifact(organization_id, request.artifactId, value)
                return value
            }
            if (operation === 'create') {
                if (hasArtifact(organization_id, request.artifactId) || await readMemoryJSON(path) !== undefined) {
                    const error = new Error(`Artifact already exists: ${request.artifactId}`)
                    error.code = 'EEXIST'
                    throw error
                }
                setArtifact(organization_id, request.artifactId, request.value)
                writeMemoryJSON(path, request.value)
                stage(path, 'set')
                return request.value
            }
            if (operation === 'update') {
                if (!hasArtifact(organization_id, request.artifactId)) {
                    const value = await readMemoryJSON(path)
                    if (value === undefined) return undefined
                    setArtifact(organization_id, request.artifactId, value)
                }
                const value = request.value
                setArtifact(organization_id, request.artifactId, value)
                writeMemoryJSON(path, value)
                stage(path, 'set')
                return value
            }
            deleteArtifact(organization_id, request.artifactId)
            markMemoryRemoval(path)
            stage(path, 'remove', { force: true })
            return true
        },
        stageJSON(path, value) { path = resolvePath(path); writeMemoryJSON(path, value); stage(path, 'set') },
        remove(path, options) {
            path = resolvePath(path)
            markMemoryRemoval(path)
            stage(path, 'remove', options)
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
