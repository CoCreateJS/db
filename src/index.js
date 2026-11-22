import {LeafTier} from './tree/leaves.js'
import { MemoryPolicy } from './tree/memory.js'
import { LocalTier } from './tree/local.js'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Config from '@cocreate/config'
import { crud, persistenceChanges } from './crud/index.js'
import { Persistence } from './persistence/index.js'
import { createConfiguration, createRootManager } from './root.js'

export function createDB(server = {}, options = {}) {
    const { forward, size = 1024, leafSize = size } = options
    const serverId = server.id
    const primary = server.isPrimary ?? (server.isWorker === true ? false : true)
    const memoryOptions = options.memoryPolicy && typeof options.memoryPolicy === 'object' ? options.memoryPolicy : {}
    const mode = options.mode ?? options.config?.mode ?? 'adaptive'
    if (!['adaptive', 'disk-first', 'disk-cache'].includes(mode)) throw new Error(`Unsupported database mode: ${mode}`)
    const acknowledgement = options.acknowledgement ?? options.config?.acknowledgement ?? 'memory'
    if (!['memory', 'disk', 'persistence'].includes(acknowledgement)) throw new Error(`Unsupported acknowledgement: ${acknowledgement}`)
    if (acknowledgement === 'persistence') throw new Error('Persistence acknowledgement requires an external persistence integration with the complete persistence tree')
    const baseDirectory = primary ? options.directory ?? join(homedir(), '.cocreate', 'db') : undefined
    if (primary && mode === 'disk-cache') {
        for (const name of ['config.json', 'config.json.tmp', 'branches', 'leaves'])
            rmSync(join(baseDirectory, name), { recursive: true, force: true })
    }
    if (primary) mkdirSync(baseDirectory, { recursive: true })
    const configPath = primary ? join(baseDirectory, 'config.json') : undefined
    let configurationOptions = options
    if (primary && mode !== 'disk-cache' && existsSync(configPath)) {
        configurationOptions = { config: JSON.parse(readFileSync(configPath, 'utf8')) }
    }
    const configuration = createConfiguration(configurationOptions)
    const db = { config: configuration, leaves: new Map(), tree: new Map(), deleting: new Set(), persistence: { pending: Object.create(null) }, baseDirectory, configPath }
    db.persistConfig = () => {
        if (!primary) return
        const temporaryPath = configPath + '.tmp'
        writeFileSync(temporaryPath, JSON.stringify(db.config))
        renameSync(temporaryPath, configPath)
    }
    if (primary) {
        db.local = new LocalTier(baseDirectory, undefined, {
            resolveLeaf: id => db.leaves.get?.(id) ?? db.deleted?.get(id)
        })
        db.leaves = new LeafTier(db.local)
    }
    const policy = primary && db.local && options.memoryPolicy !== false ? new MemoryPolicy(db.local, {memory:options.config?.memory??25,...memoryOptions},db.leaves) : null
    const roots = createRootManager({ db, size, leafSize, deferIndex: options.deferIndex ?? true, persistConfig: db.persistConfig })
    db.persistence = new Persistence({
        pending: db.persistence.pending,
        get: roots.persistenceValue,
        remove: (root, uuid, entry) => {
            const group = db.persistence.pending[root]
            if (!group || group[uuid] !== entry) return
            delete group[uuid]
            if (!Object.keys(group).length) delete db.persistence.pending[root]
        }
    })
    db.persistConfig()
    if(db.leaves instanceof LeafTier){db.leaves.pending=roots.pendingIndex;db.leaves.restore=(data)=>roots.restoreLeaf(data.object)}
    let diskQueue = Promise.resolve()
    let requestQueue = Promise.resolve()
    let acknowledgementQueue = Promise.resolve()
    let persistenceError
    function persistChanges() {
        roots.flushIndex()
        db.leaves.persistDirty()
        db.local.persistDirty()
        roots.syncIndexCatalog()
        db.persistConfig()
        persistenceError = undefined
    }
    function queuePersistence(persist = persistChanges) {
        diskQueue = diskQueue.then(() => new Promise(resolve => setImmediate(resolve))).then(persist).catch(error => {
            persistenceError = error
        })
        return diskQueue
    }
    function snapshotResult(request, result) {
        const root = String(request.method ?? '').split('.')[0]
        if (Array.isArray(result[root])) {
            result[root] = result[root].map(value => {
                if (!value || typeof value !== 'object' || typeof value.getFile !== 'function') return value
                return structuredClone(Object.fromEntries(Object.entries(value)))
            })
        }
        return result
    }
    async function persistDiskFirst() {
        await policy?.flush()
        persistChanges()
        if (db.leaves instanceof LeafTier) await db.leaves.evictBatch(db.leaves.size)
        await db.local.evictAsync(Infinity, 1)
        if (policy?.error) throw policy.error
    }
    async function execute(request) {
        const result = await executeCrud(request)
        if (acknowledgement === 'disk') {
            await policy?.flush()
            persistChanges()
        } else queuePersistence()
        policy?.check()
        if(policy?.error)throw policy.error
        return result
    }
    async function executeDiskFirst(request) {
        await diskQueue
        await policy?.flush()
        const result = snapshotResult(request, await executeCrud(request))
        diskQueue = diskQueue.then(() => new Promise(resolve => setImmediate(resolve))).then(persistDiskFirst).then(() => {
            if (mode === 'adaptive') policy?.check()
            persistenceError = undefined
        }).catch(error => {
            persistenceError = error
        })
        if (acknowledgement === 'disk') await diskQueue
        return result
    }
    async function executeCrud(request) {
        const result = await crud({ db, roots }, request)
        if (serverId == null || request.serverId == null || String(request.serverId) === String(serverId)) return result
        for (const leaf of result[persistenceChanges]) roots.clearPersistencePending(leaf)
        return result
    }
    async function flushDisk() {
        await requestQueue
        await acknowledgementQueue
        await diskQueue
        roots.flushIndex()
        await policy?.flush()
        persistChanges()
        if (policy?.error) throw policy.error
        if (persistenceError) throw persistenceError
    }
    const api = {
        ... (db.local ? {local:db.local,leafTier:db.leaves} : {}),
        persistence: db.persistence,
        baseDirectory,
        persist: () => db.persistence.persist(),
        get config() { return roots.configuration(primary) },
        async send(request) {
            if (!primary) {
                if (!forward) throw Error('worker IPC adapter required')
                return forward(request)
            }
            if (mode === 'adaptive' && !policy?.diskFirst) policy?.check()
            if (mode === 'disk-first' || policy?.diskFirst) {
                const operation = requestQueue.then(() => executeDiskFirst(request))
                requestQueue = operation.then(() => undefined, () => undefined)
                return operation
            }
            if (acknowledgement !== 'disk') return execute(request)
            const operation = acknowledgementQueue.then(() => execute(request), () => execute(request))
            acknowledgementQueue = operation.then(() => undefined, () => undefined)
            return operation
        }
    }
    Object.defineProperties(api, {
        mode: {value: mode},
        effectiveMode: {get: () => policy?.diskFirst ? 'disk-first' : mode},
        acknowledgement: {value: acknowledgement},
        memoryPolicy: {value: policy},
        flushDisk: {value: flushDisk},
        flushIndex: {value: roots.flushIndex},
        pendingIndexCount: {get: () => roots.pendingIndex.size}
    })
    return api
}

export async function init(server = {}, options = {}) {
    const primary = server.isPrimary ?? (server.isWorker === true ? false : true)
    const resolved = primary && options.prompt !== false
        ? await Config.prompt(options.config === undefined ? (options.questions ?? { db: {} }) : { db: {} }, true, options.config === undefined && options.questions !== undefined)
        : {}
    const config = {
        ...(resolved?.db ?? {}),
        ...(options.config ?? {})
    }
    return createDB(server, { ...options, config })
}

createDB.init = init
export default createDB
