import { addDistribution, getDistribution } from '@cocreate/utils/distribution'
import Config from '@cocreate/config'
import { distributionReferences } from './distribution.js'
import { createPeerDistribution, createDistributionAdapters } from './peers.js'
import { createDB } from './scoped.js'
import { resolveDirectory } from './directory.js'
import { randomUUID } from 'node:crypto'
import { getPersistence, getPersistenceDriver, sendPersistence } from './persistence/index.js'
import { splitSerializedPartition, encodePartitionEnvelope } from './partition.js'
import { localReadRequest, persistenceReadRequest } from './persistence/envelopes.js'

function errorHandler(data, error) {
    if (!Array.isArray(data.error)) data.error = data.error === undefined ? [] : [data.error]
    const errors = error?.errors ?? error?.message ?? error
    data.error.push(...(Array.isArray(errors) ? errors : [errors]))
    data.success = false
    return data
}

export const DB_PROVIDER = 'cocreate-db'

// External reads are an opt-in legacy recovery bridge, not tree persistence.
// External writes stay disabled; authoritative indexes/files live in CoCreateDB.
const EXTERNAL_PERSISTENCE_ENABLED = false
const EXTERNAL_PERSISTENCE_WRITES_ENABLED = false

const externalPersistence = (operation, enabled) => (...args) => {
    if (!enabled)
        throw new Error('External persistence is temporarily disabled.')
    return operation(...args)
}

function attachPersistenceAPI(db, bootstrapPersistence, enabled) {
    db.persistence = {
        bootstrap: bootstrapPersistence,
        enabled,
        get: externalPersistence(getPersistence, enabled),
        getDriver: externalPersistence(getPersistenceDriver, enabled),
        send: externalPersistence((request, context = {}) => {
            if (request.method !== 'object.read') throw new Error('External recovery supports object.read only; provider writes are disabled.')
            return sendPersistence(persistenceReadRequest(request), { ...context, bootstrapPersistence })
        }, enabled)
    }
    return db
}

async function resolveDBOptions(options = {}) {
    const suppliedConfig = options.config || {}
    const suppliedDBConfig = suppliedConfig.db ||
        (Object.hasOwn(suppliedConfig, 'directory') || Object.hasOwn(suppliedConfig, 'persistence')
            ? suppliedConfig
            : {})
    const shouldPrompt = options.prompt !== false
    const promptConfig = shouldPrompt && options.directory === undefined && suppliedDBConfig.directory === undefined &&
        !process.env.COCREATE_DB_DIRECTORY
        ? await Config.prompt({
            'db.directory': {
                prompt: 'Enter the CoCreateDB directory (leave blank to use the current directory): '
            }
        })
        : {};
    const dbConfig = Config.get('db') || {}
    const directory = resolveDirectory({
        directory: options.directory ?? process.env.COCREATE_DB_DIRECTORY ??
            suppliedDBConfig.directory ?? promptConfig.db?.directory ?? dbConfig.directory
    })
    const persistence = options.persistence ?? suppliedDBConfig.persistence ?? dbConfig.persistence
    const bootstrapPersistence = options.bootstrapPersistence ?? Config.get('persistence')
    if (persistence !== undefined && persistence !== false && (!persistence || typeof persistence !== 'object' || Array.isArray(persistence)))
        throw new TypeError('CoCreateDB persistence configuration must be an object.')
    const { prompt, ...runtimeOptions } = options
    return { ...dbConfig, ...suppliedDBConfig, ...runtimeOptions, directory, persistence, bootstrapPersistence }
}

/** Initialize CoCreateDB as a Cluster-owned server module. */
export async function init(server, options = {}) {
    if (!server?.isPrimary)
        return initializeServerDB(server, { ...options,
            externalPersistence: options.externalPersistence ?? Config.get('db')?.externalPersistence,
            persistence: options.persistence ?? Config.get('db')?.persistence,
            bootstrapPersistence: options.bootstrapPersistence ?? Config.get('persistence') })
    return initializeServerDB(server, await resolveDBOptions(options))
}

/** Create a standalone DB service with the same DB-owned config and path rules. */
export async function initLocal(options = {}) {
    const config = await resolveDBOptions(options)
    if (config.persistence?.workflow)
        throw new Error('Workflow persistence requires a Cluster server instance.')
    const persistenceOptions = config.persistence ?? config.persistenceOptions
    return createDB({
        ...config,
        memoryCache: config.memoryCache ?? false,
        ...(persistenceOptions ? {
            writeBehind: config.writeBehind ?? true,
            persistenceOptions
        } : {})
    })
}

export const CoCreateDB = { init, initLocal }

function idsFrom(payload) {
    return {
        organization_id: payload.organization_id,
        storageId: payload.storageId,
        storage: payload.storage,
        databaseId: payload.databaseId,
        arrayId: payload.arrayId,
        objectId: payload.objectId,
        nodeId: payload.nodeId,
        operation: payload.operation
    }
}

/** Attach the primary DB engine or a worker IPC driver. */
export function initializeServerDB(server, {
    directory = process.env.COCREATE_DB_DIRECTORY || process.cwd(),
    maxIndexBytes,
    cache = false,
    memoryCache = true,
    memoryOnly = false,
    disk = true,
    externalPersistence: externalPersistenceEnabled = EXTERNAL_PERSISTENCE_ENABLED,
    writeBehind = true,
    persistence,
    bootstrapPersistence,
    persistenceWorkflow = process.env.COCREATE_DB_PERSISTENCE_WORKFLOW,
    storageWorkflow = process.env.COCREATE_DB_STORAGE_WORKFLOW,
    persistenceOptions = {},
    peerTimeoutMs = 5000
} = {}) {
    if (!server?.id || typeof server.send !== 'function')
        throw new TypeError('A initialized CoCreate server with an id and send() is required')

    const requestPrimary = async (method, payload = {}) => {
        try {
            const response = await server.send({ method, ...payload, master: true, broadcast: false })
            if (response?.success === false && !response.result)
                return errorHandler(response, response.error === undefined ? `${method} failed` : [])
            return response?.result
        } catch (error) { return errorHandler({ ...payload.data }, error) }
    }

    const providerEnabled = externalPersistenceEnabled && persistence !== false && !memoryOnly
    // Workers own only this driver: no engine, filesystem access, or payload cache.
    if (!server.isPrimary) {
        server.db = attachPersistenceAPI({ send: (request, context = {}) => requestPrimary('db.send', { data: request, organization: context.organization }) }, bootstrapPersistence, providerEnabled)
        return server.db
    }

    // DB replication uses the existing control transport. Tenant identity belongs
    // inside its scope, rather than the client-notification organization field.
    const meshSend = async payload => {
        const { organization_id, storageId, storage, ...message } = payload
        const envelope = organization_id ? { ...message, scope: { organization_id, storageId, storage } } : payload
        // Preserve the encoding through Mesh so ordinary partitions encode once.
        // Whole documents do not use this split path.
        if (envelope.value && ['db.partition.update', 'db.partition.response'].includes(envelope.method)) {
            envelope.uuid ??= randomUUID()
            const { encoded, bytes } = encodePartitionEnvelope(envelope)
            const changes = await splitSerializedPartition(envelope.value, bytes)
            if (changes) {
                const prefix = envelope.path.slice(0, -changes.path.length)
                for (const change of changes.partitions) publish({
                    method: 'db.partition.update', server: envelope.server,
                    serverId: server.id, operation: 'set', ...change, path: prefix + change.path
                })
                if (envelope.method === 'db.partition.update') return
                // The requested address remains valid after its local split.
                await dispatchChanges()
                return meshSend(envelope)
            }
            return server.cluster.send(envelope, encoded)
        }
        return server.cluster.send(envelope)
    }
    const peers = createPeerDistribution(server.id)
    const adapters = createDistributionAdapters(server.id, peers)
    const session = randomUUID()
    let revision = 0
    let db, backgroundError
    const errorResponse = (data, error) => {
        const response = errorHandler({ ...data }, error)
        backgroundError = { method: data.method, error: response.error }
        return response
    }
    const deliver = (data, operation) => {
        try {
            return Promise.resolve(operation()).then(response => {
                if (response?.error?.length) backgroundError = { method: data.method, error: response.error }
                return response
            }).catch(error => errorResponse(data, error))
        }
        catch (error) { return Promise.resolve(errorResponse(data, error)) }
    }
    const peerRequests = new Map()
    const partitionRequests = new Map()
    let transactionQueue = Promise.resolve()
    let outgoing
    let messageId = 0
    const publish = payload => {
        if (!outgoing) return meshSend(payload)
        const key = payload.method === 'db.partition.update'
            ? JSON.stringify([payload.server, payload.path, payload.organization_id, payload.storageId])
            : ++messageId
        outgoing.set(key, payload)
    }
    const dispatchChanges = async () => {
        while (outgoing?.size) {
            const [key, payload] = outgoing.entries().next().value
            outgoing.delete(key)
            await meshSend(payload)
        }
    }
    const withPropagation = async operation => {
        const release = db?.holdPersistence?.()
        const messages = new Map()
        outgoing = messages
        try {
            const result = await operation()
            await dispatchChanges()
            return result
        } finally { outgoing = undefined; release?.() }
    }
    const serializeTransaction = operation => {
        const result = transactionQueue.then(() => withPropagation(operation))
        transactionQueue = result.catch(() => {})
        return result
    }
    const serializeReplication = (data, operation) => serializeTransaction(operation)
        .catch(error => errorResponse(data, error))

    const readFromPeer = ({ nodeId, ...entity }) => {
        if (nodeId === server.id) return db.readLocalEntity(entity)

        const requestId = randomUUID()
        const request = {
            requesterId: server.id,
            targetId: nodeId,
            requestId,
            ...entity
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                peerRequests.delete(requestId)
                reject(new Error(`Peer ${nodeId} did not answer the CoCreateDB document request`))
            }, peerTimeoutMs)
            peerRequests.set(requestId, { nodeId, resolve, reject, timer })
            try {
                meshSend({
                    method: 'db.document.request',
                    server: nodeId,
                    ...request
                })
            } catch (error) {
                clearTimeout(timer)
                peerRequests.delete(requestId)
                reject(error)
            }
        })
    }

    const requestPartitionFromPeer = (nodeId, path) => {
        const requestId = randomUUID()
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                partitionRequests.delete(requestId)
                reject(new Error(`Peer ${nodeId} did not answer the CoCreateDB index partition request`))
            }, peerTimeoutMs)
            partitionRequests.set(requestId, { nodeId, resolve, reject, timer })
            try {
                meshSend({
                    method: 'db.partition.request',
                    server: nodeId,
                    requesterId: server.id,
                    targetId: nodeId,
                    requestId,
                    path
                })
            } catch (error) {
                clearTimeout(timer)
                partitionRequests.delete(requestId)
                reject(error)
            }
        })
    }

    const readPartitionFromPeers = async path => {
        const nodeIds = await db.getPartitionHolders(path)
        for (const nodeId of nodeIds) {
            if (nodeId === server.id) {
                const local = await db.readIndexPartition(path)
                if (local !== undefined) return local
                continue
            }
            try {
                const partition = await requestPartitionFromPeer(nodeId, path)
                if (partition !== undefined) return partition
            } catch {}
        }
        if (nodeIds.length)
            throw new Error(`Index partition ${path} is advertised but no holder could provide it`)
        return undefined
    }

    const localPartitionChange = async (payload, apply) => {
        const partitionId = payload.path ?? payload.partitionId
        const previous = await db.getPartitionHolders(partitionId)
        const operation = payload.operation === 'remove' ? 'remove' : 'add'
        const result = await apply({ partitionId, nodeId: payload.nodeId ?? server.id, operation })

        if (result.changed) {
            publish({
                method: 'db.partition.availability',
                session, revision: ++revision,
                broadcast: true,
                workers: false,
                serverId: payload.nodeId ?? server.id,
                partitionId,
                operation
            })
        }

        if (!payload.acquired && !payload.replicated) {
            for (const nodeId of previous) {
                if (nodeId === (payload.nodeId ?? server.id)) continue
                publish({
                    method: 'db.partition.update',
                    server: nodeId,
                    serverId: payload.nodeId ?? server.id,
                    path: partitionId,
                    operation: payload.operation === 'remove' ? 'remove' : 'set',
                    value: payload.value
                })
            }
        }
        return result
    }

    const partitionAdapter = {
        ...adapters.partitionAdapter,
        onLocalChange: localPartitionChange,
        read: readPartitionFromPeers
    }

    const documentMutationAdapter = {
        publish: mutation => {
            for (const targetId of mutation.targets) {
                publish({
                    method: 'db.object.mutation',
                    server: targetId,
                    serverId: server.id,
                    ...mutation
                })
            }
        }
    }

    const distributionAdapter = {
        ...adapters.distributionAdapter,
        onLocalChange: async (payload, apply) => {
            const result = await apply(payload)
            if (result.changed) {
                publish({
                    method: 'db.distribution', session, revision: ++revision, broadcast: true, workers: false,
                    serverId: server.id, ...idsFrom(payload)
                })
            }
            return result
        }
    }

    db = createDB({
        directory,
        maxIndexBytes,
        cache,
        memoryCache,
        memoryOnly,
        disk,
        peerDistribution: peers,
        nodeId: server.id,
        distributionAdapter,
        peerReader: readFromPeer,
        partitionAdapter,
        documentMutationAdapter,
        onStorageChange: payload => publish({ method: 'db.storage.mutation', broadcast: true, workers: false, serverId: server.id, ...payload }),
        writeBehind,
        scheduleIndexing: serializeTransaction,
        onIndexed: async data => {
            // Dispatch holder updates before allowing this revision to persist.
            await dispatchChanges()
            const keys = distributionReferences({ ...data, objectIds: [data.objectId] }, true)
            const notification = { method: 'db.indexed', data, master: false, broadcast: false,
                worker: [...getDistribution(server.workers.distribution, keys)] }
            deliver(notification, () => server.send(notification))
        },
        persistenceOptions: {
            ...(persistence ?? persistenceOptions),
            ...((EXTERNAL_PERSISTENCE_WRITES_ENABLED && providerEnabled && (persistence?.workflow ?? persistenceWorkflow ?? storageWorkflow)) ? { storage: async item => {
                const workflow = persistence?.workflow ?? persistenceWorkflow ?? storageWorkflow
                if (!server.workflow?.run) throw new Error('Storage workflow service is unavailable')
                const result = await server.workflow.run({
                    method: workflow.startsWith('workflow.') ? workflow : `workflow.${workflow}`,
                    organization_id: server.organization_id,
                    host: server.host,
                    storage: [item]
                })
                if (result?.success !== true || (Array.isArray(result.error) ? result.error.length : result.error))
                    throw new Error('Storage workflow did not acknowledge persistence')
            } } : {}),
            ...(!EXTERNAL_PERSISTENCE_WRITES_ENABLED || !providerEnabled ? { storage: undefined } : {})
        }
    })

    const sendLocal = db.send.bind(db)
    const persistenceStats = db.persistenceStats.bind(db)
    db.persistenceStats = () => ({ ...persistenceStats(), backgroundError })
    let closing = false
    // Reads also queue so they cannot observe a partially updated index.
    db.send = (request, { workerId = server.workerId, organization } = {}) => {
        if (closing && ['create', 'update', 'delete'].includes(request?.method?.split('.')?.[1]))
            return Promise.resolve(errorHandler({ ...request }, 'Database is closing'))
        return serializeTransaction(async () => {
            const [type, method] = String(request?.method || '').split('.')
            let result = await sendLocal(method === 'read' ? localReadRequest(request) : request)
            const organizationConfig = organization || request?.organization
            const hasProvider = providerEnabled && (request?.persistence || organizationConfig?.bootstrapPersistence ||
                organizationConfig?.persistence || organizationConfig?.bootstrapStorage ||
                bootstrapPersistence || Config.get('persistence'))
            const hasLocalErrors = Array.isArray(result?.error) ? result.error.length > 0 : Boolean(result?.error)
            if (hasProvider && type === 'object' && method === 'read' && result?.success !== false && !hasLocalErrors &&
                !(Array.isArray(result?.[type]) && result[type].length)) {
                const persisted = await sendPersistence(persistenceReadRequest(request), {
                    organization: organizationConfig,
                    organizationId: request.organization_id,
                    bootstrapPersistence
                })
                const errors = Array.isArray(persisted?.error) ? persisted.error : persisted?.error ? [persisted.error] : []
                if (persisted?.success === false || errors.length) return errorHandler(result, errors.length ? errors : ['Persistence read failed.'])
                await db.hydrateObjects(request, persisted?.object ?? [])
                result = await sendLocal(localReadRequest(request))
            }
            if (EXTERNAL_PERSISTENCE_WRITES_ENABLED && hasProvider && type === 'object' && ['create', 'update', 'delete'].includes(method) && result?.success !== false &&
                !(Array.isArray(result?.error) ? result.error.length : result?.error)) {
                const persisted = await sendPersistence(result, {
                    organization: organizationConfig,
                    organizationId: request.organization_id,
                    bootstrapPersistence
                })
                const persistenceErrors = Array.isArray(persisted?.error)
                    ? persisted.error
                    : persisted?.error ? [persisted.error] : []
                if (persisted?.success === false || persisted?.status === false || persistenceErrors.length) {
                    result.success = false
                    result.error = [...(Array.isArray(result.error) ? result.error : result.error ? [result.error] : []), ...persistenceErrors]
                    if (!result.error.length) result.error = ['Persistence failed.']
                }
            }
            if (result.distribution?.length && workerId != null) {
                addDistribution(server.workers.distribution, result.distribution, workerId)
                if (request.clientId) {
                    const message = { method: 'db.distribution.set', server: server.id, serverId: server.id,
                        worker: workerId, master: false, broadcast: false,
                        data: { organization_id: request.organization_id, clientId: request.clientId, distribution: result.distribution } }
                    if (workerId === server.workerId) server.emit('db.distribution.set', message)
                    else {
                        const registered = await server.send(message)
                        if (registered?.success === false)
                            throw Object.assign(new Error('Distribution registration failed'), {
                                errors: registered.error?.length ? registered.error : ['Distribution registration failed']
                            })
                    }
                }
            }
            return result
        }).catch(error => errorHandler({ ...request }, error))
    }
    const flushIndexesLocal = db.flushIndexes.bind(db)
    const closeLocal = db.close.bind(db)
    db.flush = async () => {
        await serializeTransaction(flushIndexesLocal)
        await db.flushPersistence()
    }
    db.close = async () => {
        closing = true
        await db.flush()
        // Persistence/workflow I/O must not hold the primary operation queue:
        // the workflow service reads its configuration through CRUD itself.
        await closeLocal()
    }
    if (writeBehind) {
        server.shutdownHandlers ||= new Set()
        server.shutdownHandlers.add(() => db.close())
    }

    server.workers ||= new Map()
    server.workers.distribution ||= new Map()
    attachPersistenceAPI(db, bootstrapPersistence, providerEnabled)
    server.db = db

    if (server.isPrimary) {
        server.on('db.send', async payload => {
            const result = await db.send(payload.data, { workerId: payload.workerId ?? server.workerId, organization: payload.organization })
            return { ...payload, success: result.success !== false, result }
        })
        const localChange = async payload => {
            const result = await db.updateDistribution(idsFrom(payload.data ?? payload))
            if (result.changed) {
                publish({
                    method: 'db.distribution',
                    session, revision: ++revision,
                    broadcast: true,
                    workers: false,
                    serverId: server.id,
                    ...idsFrom(payload.data ?? payload)
                })
            }
            return { ...payload, success: true, result }
        }

        server.on('db.distribution.local', payload => serializeTransaction(() => localChange(payload)))
        server.on('db.distribution.update', async payload => ({
            ...payload,
            success: true,
            result: await serializeTransaction(() => db.updateDistribution(idsFrom(payload.data ?? payload)))
        }))
        server.on('db.distribution.get', async payload => ({
            ...payload,
            success: true,
            result: await db.getDistribution(payload.data ?? payload)
        }))
        server.on('db.distribution.list', async payload => ({
            ...payload,
            success: true,
            result: await db.listDistribution(payload.data ?? payload)
        }))
        server.on('db.partition.update', async payload => ({
            ...payload,
            success: true,
            result: await serializeTransaction(() => db.updatePartition(payload.data ?? payload))
        }))
        server.on('db.partition.get', async payload => ({
            ...payload,
            success: true,
            result: await db.getPartitionHolders((payload.data ?? payload).path)
        }))
        server.on('db.partition.list', async payload => ({
            ...payload,
            success: true,
            result: await db.listPartitions()
        }))
        server.on('db.partition.local', async payload => {
            const data = payload.data ?? payload
            return { ...payload, success: true, result: await serializeTransaction(() => localPartitionChange(data, db.updatePartition)) }
        })
        server.on('db.partition.acquire', async payload => ({
            ...payload,
            success: true,
            result: await readPartitionFromPeers((payload.data ?? payload).path)
        }))
        server.on('db.peer.fetch', async payload => {
            const data = payload.data ?? payload
            const record = await readFromPeer(data)
            return { ...payload, success: true, result: record }
        })
        server.on('db.distribution', payload => serializeTransaction(() => db.updateDistribution(idsFrom(payload.data ?? payload))))
        server.cluster.on('db.document.request', payload => {
            payload = { ...payload, ...payload.scope }
            if (payload.targetId !== server.id || !payload.requesterId || !payload.requestId) return
            Promise.resolve(db.readLocalEntity(payload)).then(record => {
                const response = {
                    requesterId: payload.requesterId,
                    responderId: server.id,
                    requestId: payload.requestId,
                    record
                }
                meshSend({
                    method: 'db.document.response',
                    server: payload.requesterId,
                    ...response
                })
            }).catch(error => {
                const response = {
                    requesterId: payload.requesterId,
                    responderId: server.id,
                    requestId: payload.requestId,
                }
                errorHandler(response, error)
                meshSend({
                    method: 'db.document.response',
                    server: payload.requesterId,
                    ...response
                })
            })
        })
        server.cluster.on('db.document.response', payload => {
            const pending = peerRequests.get(payload.requestId)
            if (!pending || pending.nodeId !== payload.responderId || payload.requesterId !== server.id) return
            peerRequests.delete(payload.requestId)
            clearTimeout(pending.timer)
            if (payload.error?.length) pending.reject(Object.assign(new Error('Peer request failed'), { errors: payload.error }))
            else pending.resolve(payload.record)
        })
        server.cluster.on('db.partition.request', payload => {
            if (payload.targetId !== server.id || !payload.requesterId || !payload.requestId) return
            serializeTransaction(async () => {
                const value = await db.readIndexPartition(payload.path)
                await meshSend({
                    method: 'db.partition.response',
                    server: payload.requesterId,
                    requesterId: payload.requesterId,
                    responderId: server.id,
                    requestId: payload.requestId,
                    path: payload.path,
                    value
                })
            }).catch(error => {
                meshSend(errorHandler({
                    method: 'db.partition.response',
                    server: payload.requesterId,
                    requesterId: payload.requesterId,
                    responderId: server.id,
                    requestId: payload.requestId
                }, error))
            })
        })
        server.cluster.on('db.partition.response', payload => {
            const pending = partitionRequests.get(payload.requestId)
            if (!pending || pending.nodeId !== payload.responderId || payload.requesterId !== server.id) return
            partitionRequests.delete(payload.requestId)
            clearTimeout(pending.timer)
            if (payload.error?.length) pending.reject(Object.assign(new Error('Peer request failed'), { errors: payload.error }))
            else pending.resolve(payload.value)
        })
        server.cluster.on('db.partition.update', payload => {
            if (payload.serverId === server.id) return
            return serializeReplication(payload, () => payload.operation === 'remove'
                ? db.removeIndexPartition(payload.path, { replicated: true })
                : db.applyIndexPartition(payload.path, payload.value, { replicated: true }))
        })
        server.cluster.on('db.storage.mutation', payload => {
            payload = { ...payload, ...payload.scope }
            if (payload.serverId === server.id) return
            return serializeReplication(payload, () => db.applyStorageMutation(payload))
        })
        server.cluster.on('db.object.mutation', payload => {
            payload = { ...payload, ...payload.scope }
            if (payload.serverId === server.id || !Array.isArray(payload.targets) || !payload.targets.includes(server.id)) return
            return serializeTransaction(async () => {
                const applied = await db.applyReplicatedObjectMutation(payload)
                if (!applied) return
                let object = payload.object
                if (payload.operation !== 'remove') {
                    const current = await db.readLocalEntity({ ...payload, type: 'object', databaseId: payload.database._id,
                        arrayId: payload.array._id, objectId: payload.object._id })
                    object = payload.operation === 'update' ? { ...current, $update: payload.object.$update } : current
                }
                const data = { method: 'object.' + (payload.operation === 'remove' ? 'delete' : payload.operation === 'update' ? 'update' : 'create'),
                    organization_id: payload.organization_id, storage: payload.storage, database: payload.database.name, array: payload.array.name,
                    object: [object], success: true, master: false, broadcast: false, server: server.id }
                data.distributionKeys = distributionReferences({ ...payload, databaseId: payload.database._id, arrayId: payload.array._id, objectIds: [payload.object._id] }, true)
                data.worker = [...getDistribution(server.workers.distribution, data.distributionKeys)]
                return data
            }).then(data => data && server.send(data))
                .catch(error => errorResponse(payload, error))
        })
        server.cluster.on('db.partition.availability', payload => {
            if (payload.serverId === server.id) return
            return serializeReplication(payload, () => peers.change({
                partitionId: payload.partitionId, nodeId: payload.serverId, operation: payload.operation
            }, payload.session, payload.revision))
        })
        server.cluster.on('db.distribution', payload => {
            if (payload.serverId === server.id) return
            return serializeReplication(payload, () => peers.change({
                ...payload, ...payload.scope, nodeId: payload.nodeId ?? payload.serverId
            }, payload.session, payload.revision))
        })
        const sendInventory = (nodeId, reply = false) => serializeTransaction(async () => {
            const inventory = await db.distribution.local.snapshot()
            // Snapshot reads can discover local partitions and queue announcements.
            await dispatchChanges()
            return meshSend({ method: 'db.distribution.sync', server: nodeId, serverId: server.id,
                session, revision, reply, inventory })
        })
        server.cluster.on('db.distribution.sync', payload => {
            if (payload.serverId === server.id) return
            return serializeReplication(payload, () => peers.replace(payload.serverId, payload.inventory, payload.session, payload.revision))
                .then(() => !payload.reply && sendInventory(payload.serverId, true))
                .catch(error => errorResponse(payload, error))
        })
        server.cluster.on('peerConnected', ({ nodeId }) => {
            peers.connect(nodeId)
            deliver({ method: 'db.distribution.sync', nodeId }, () => sendInventory(nodeId))
        })
        server.cluster.on('peerDisconnected', ({ nodeId }) => {
            return serializeReplication({ method: 'db.distribution.disconnect', nodeId }, () => peers.remove(nodeId))
        })
        // DB may be attached after control connections have already opened.
        for (const socket of server.cluster.controlSockets ?? []) {
            if (socket.serverId) deliver({ method: 'db.distribution.sync' }, () => sendInventory(socket.serverId))
        }
    }

    return db
}

export default initializeServerDB
