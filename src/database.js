import { MemoryPolicy } from './tree/memory.js'
import { LeafTier } from './tree/leaves.js'
import { LocalTier } from './tree/local-core.js'
import { crud, persistenceChanges, postAcknowledgement } from './crud/index.js'
import { Persistence } from './persistence/index.js'
import { createConfiguration, createRootManager } from './root.js'
import { nextTurn } from './defer.js'

export async function createDatabase(server = {}, options = {}, platform = {}) {
    const { forward, size = 1024, leafSize = size } = options
    const serverId = server.id
    const primary = platform.primary ?? (server.isPrimary ?? (server.isWorker === true ? false : true))
    const memoryOptions = options.memoryPolicy && typeof options.memoryPolicy === 'object' ? options.memoryPolicy : {}
    const mode = options.mode ?? options.config?.mode ?? platform.defaultMode ?? 'adaptive'
    if (!['adaptive', 'disk-first', 'disk-cache'].includes(mode)) throw new Error(`Unsupported database mode: ${mode}`)
    const acknowledgement = options.acknowledgement ?? options.config?.acknowledgement ?? platform.defaultAcknowledgement ?? 'memory'
    if (!['memory', 'disk', 'persistence'].includes(acknowledgement)) throw new Error(`Unsupported acknowledgement: ${acknowledgement}`)
    if (acknowledgement === 'persistence') throw new Error('Persistence acknowledgement requires an external persistence integration with the complete persistence tree')
    const baseDirectory = platform.baseDirectory
    const storage = primary ? platform.storage : undefined
    const configuration = createConfiguration(platform.configurationOptions ?? options)
    const db = { config: configuration, leaves: new Map(), tree: new Map(), deleting: new Set(), persistence: { pending: Object.create(null) }, baseDirectory }
    db.persistConfig = async () => {
        if (primary) await platform.persistConfig?.(db.config)
    }

    if (primary && storage) {
        db.local = new LocalTier(storage, undefined, { resolveLeaf: async id => await db.leaves.get?.(id) ?? db.deleted?.get(id) })
        await db.local.initialize()
        db.leaves = new LeafTier(db.local)
    }

    const policy = primary && db.local && platform.memoryPolicy !== false && options.memoryPolicy !== false
        ? new MemoryPolicy(db.local, { memory: options.config?.memory ?? 25, ...memoryOptions }, db.leaves)
        : null
    if (policy && typeof server.on === 'function') {
        const telemetryTimestamps = new Map()
        server.on('telemetry', message => {
            const sample = message?.data
            if (!sample || (serverId != null && String(sample.serverId) !== String(serverId))) return
            const timestamp = sample.timestamp
            const workerId = String(sample.workerId ?? message.workerId ?? 0)
            if (typeof timestamp !== 'string' || telemetryTimestamps.get(workerId) === timestamp) return
            telemetryTimestamps.set(workerId, timestamp)
            policy.update(sample)
        })
    }

    const roots = await createRootManager({ db, size, leafSize, deferIndex: options.deferIndex ?? true, persistConfig: db.persistConfig })
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
    await db.persistConfig()
    if (db.leaves instanceof LeafTier) {
        db.leaves.pending = roots.pendingIndex
        db.leaves.restore = data => roots.restoreLeaf(data.object)
    }

    let diskQueue = Promise.resolve()
    let requestQueue = Promise.resolve()
    let backgroundQueue = Promise.resolve()
    let persistenceError
    let backgroundError
    let persistenceRequested = false
    let persistenceRunning = false

    async function persistChanges() {
        await roots.flushIndex()
        await db.leaves.persistDirty()
        await db.local.persistDirty()
        roots.syncIndexCatalog()
        await db.persistConfig()
        persistenceError = undefined
    }

    function queuePersistence(persist = persistChanges) {
        persistenceRequested = true
        if (persistenceRunning) return diskQueue
        persistenceRunning = true
        diskQueue = diskQueue.then(async () => {
            while (persistenceRequested) {
                persistenceRequested = false
                await nextTurn()
                try { await persist(); persistenceError = undefined }
                catch (error) { persistenceError = error }
            }
        }).finally(() => {
            persistenceRunning = false
            if (persistenceRequested) queuePersistence(persist)
        })
        return diskQueue
    }

    function runPostAcknowledgement(callback, persist = false) {
        const task = backgroundQueue.then(nextTurn).then(callback)
        backgroundQueue = task.catch(error => { backgroundError = error })
        if (persist) task.then(
            () => queuePersistence(),
            error => queuePersistence().then(() => { backgroundError = error })
        )
        return task
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
        await persistChanges()
        if (db.leaves instanceof LeafTier) await db.leaves.evictBatch(db.leaves.size)
        await db.local.evictAsync(Infinity, 1)
        if (policy?.error) throw policy.error
    }

    async function execute(request) {
        const result = await executeCrud(request)
        const postAck = result?.[postAcknowledgement]
        if (postAck && acknowledgement !== 'disk') {
            runPostAcknowledgement(postAck, true)
            return result
        }
        if (postAck) await postAck()
        if (String(request.method ?? '').split('.')[1] !== 'read') {
            if (acknowledgement === 'disk') {
                await policy?.flush()
                await persistChanges()
            } else queuePersistence()
        }
        if (policy?.error) throw policy.error
        return result
    }

    async function executeDiskFirst(request) {
        await diskQueue
        await policy?.flush()
        const result = snapshotResult(request, await executeCrud(request))
        const postAck = result?.[postAcknowledgement]
        const finalization = postAck ? runPostAcknowledgement(postAck) : Promise.resolve()
        diskQueue = diskQueue.then(() => finalization).then(persistDiskFirst).then(() => {
            persistenceError = undefined
        }).catch(error => { persistenceError = error })
        if (acknowledgement === 'disk') await diskQueue
        return result
    }

    async function executeCrud(request) {
        const result = await crud({ db, roots, deferObjectCreate: true }, request)
        if (serverId == null || request.serverId == null || String(request.serverId) === String(serverId)) return result
        const postAck = result?.[postAcknowledgement]
        if (postAck) {
            Object.defineProperty(result, postAcknowledgement, {
                value: async () => {
                    try { await postAck() }
                    finally { for (const leaf of result[persistenceChanges]) await roots.clearPersistencePending(leaf) }
                }
            })
            return result
        }
        for (const leaf of result[persistenceChanges]) await roots.clearPersistencePending(leaf)
        return result
    }

    async function flushDisk() {
        await requestQueue
        await backgroundQueue
        await diskQueue
        await roots.flushIndex()
        await policy?.flush()
        await persistChanges()
        if (policy?.error) throw policy.error
        if (backgroundError) throw backgroundError
        if (persistenceError) throw persistenceError
    }

    const api = {
        ...(db.local ? { local: db.local, leafTier: db.leaves } : {}),
        persistence: db.persistence,
        baseDirectory,
        persist: () => db.persistence.persist(),
        get config() { return roots.configuration(primary) },
        async send(request) {
            if (!primary) {
                if (!forward) throw Error('worker IPC adapter required')
                return forward(request)
            }
            const operation = requestQueue.then(
            () => platform.forceDiskFirst || mode === 'disk-first' || policy?.diskFirst ? executeDiskFirst(request) : execute(request),
            () => platform.forceDiskFirst || mode === 'disk-first' || policy?.diskFirst ? executeDiskFirst(request) : execute(request)
            )
            requestQueue = operation.then(() => undefined, () => undefined)
            return operation
        }
    }

    Object.defineProperties(api, {
        mode: { value: mode },
        effectiveMode: { get: () => platform.forceDiskFirst || policy?.diskFirst ? 'disk-first' : mode },
        acknowledgement: { value: acknowledgement },
        memoryPolicy: { value: policy },
        flushDisk: { value: flushDisk },
        flushIndex: { value: async () => {
            await backgroundQueue
            if (backgroundError) { const error = backgroundError; backgroundError = undefined; throw error }
            return await roots.flushIndex()
        } },
        pendingIndexCount: { get: () => roots.pendingIndex.size }
    })
    return api
}

export default createDatabase
