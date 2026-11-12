import { addDistribution, getDistribution } from '@cocreate/utils/distribution'
import Config from '@cocreate/config'
import { distributionReferences } from './distribution.js'
import { createDB } from './scoped.js'
import { resolveDirectory } from './directory.js'
import { randomUUID } from 'node:crypto'
import { getPersistence, getPersistenceDriver, sendPersistence } from './persistence/index.js'

export const DB_PROVIDER = 'cocreate-db'


function attachPersistenceAPI(db, bootstrapPersistence) {
    db.persistence = {
        bootstrap: bootstrapPersistence,
        get: getPersistence,
        getDriver: getPersistenceDriver,
        send: (request, context = {}) => sendPersistence(request, { ...context, bootstrapPersistence })
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
    if (persistence !== undefined && (!persistence || typeof persistence !== 'object' || Array.isArray(persistence)))
        throw new TypeError('CoCreateDB persistence configuration must be an object.')
    const { prompt, ...runtimeOptions } = options
    return { ...dbConfig, ...suppliedDBConfig, ...runtimeOptions, directory, persistence, bootstrapPersistence }
}

/** Initialize CoCreateDB as a Cluster-owned server module. */
export async function init(server, options = {}) {
    if (!server?.isPrimary)
        return initializeServerDB(server, { ...options, bootstrapPersistence: options.bootstrapPersistence ?? Config.get('persistence') })
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
        const response = await server.send({ method, ...payload, master: true, broadcast: false })
        if (response?.success === false && !response.result)
            throw new Error(response.error || `${method} failed`)
        return response?.result
    }

    // Workers own only this driver: no engine, filesystem access, or payload cache.
    if (!server.isPrimary) {
        server.db = attachPersistenceAPI({ send: (request, context = {}) => requestPrimary('db.send', { data: request, organization: context.organization }) }, bootstrapPersistence)
        return server.db
    }

    // DB replication uses the existing control transport. Tenant identity belongs
    // inside its scope, rather than the client-notification organization field.
    const meshSend = payload => {
        const { organization_id, storageId, storage, ...message } = payload
        return server.cluster.send(organization_id ? { ...message, scope: { organization_id, storageId, storage } } : payload)
    }
    let db
    const peerRequests = new Map()
    const partitionRequests = new Map()
    let transactionQueue = Promise.resolve()
    let outgoing
    const publish = payload => outgoing ? outgoing.push(payload) : meshSend(payload)
    const dispatchChanges = () => {
        while (outgoing?.length) {
            meshSend(outgoing[0])
            outgoing.shift()
        }
    }
    const withPropagation = async operation => {
        const release = db?.holdPersistence?.()
        const messages = []
        outgoing = messages
        try {
            const result = await operation()
            dispatchChanges()
            return result
        } finally { outgoing = undefined; release?.() }
    }
    const serializeTransaction = operation => {
        const result = transactionQueue.then(() => withPropagation(operation))
        transactionQueue = result.catch(() => {})
        return result
    }
    const serializeReplication = operation => serializeTransaction(operation).catch(error => {
        console.error('[CoCreateDB] Failed to apply a replication event:', error)
    })

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
        update: (payload, apply) => apply(payload),
        get: (path, read) => read(path),
        list: read => read(),
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
        update: (payload, apply) => apply(payload),
        get: (payload, read) => read(payload),
        list: (payload, read) => read(payload),
        onLocalChange: async (payload, apply) => {
            const result = await apply(payload)
            if (result.changed) {
                publish({
                    method: 'db.distribution', broadcast: true, workers: false,
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
            dispatchChanges()
            const keys = distributionReferences({ ...data, objectIds: [data.objectId] }, true)
            Promise.resolve(server.send({ method: 'db.indexed', data, master: false, broadcast: false, worker: [...getDistribution(server.workers.distribution, keys)] }))
                .catch(error => console.error('[CoCreateDB] Index notification failed:', error.message))
        },
        persistenceOptions: {
            ...(persistence ?? persistenceOptions),
            ...((persistence?.workflow ?? persistenceWorkflow ?? storageWorkflow) ? { storage: async item => {
                const workflow = persistence?.workflow ?? persistenceWorkflow ?? storageWorkflow
                if (!server.workflow?.run) throw new Error('Storage workflow service is unavailable')
                const result = await server.workflow.run({
                    method: workflow.startsWith('workflow.') ? workflow : `workflow.${workflow}`,
                    organization_id: server.organization_id,
                    host: server.host,
                    storage: [item]
                }, { internal: true })
                if (result?.success !== true || (Array.isArray(result.error) ? result.error.length : result.error))
                    throw new Error('Storage workflow did not acknowledge persistence')
            } } : {})
        }
    })

    const sendLocal = db.send.bind(db)
    let closing = false
    // Reads also queue so they cannot observe a partially updated index.
    db.send = (request, { workerId = server.workerId, organization } = {}) => {
        if (closing && ['create', 'update', 'delete'].includes(request?.method?.split('.')?.[1]))
            return Promise.resolve({ ...request, success: false, error: 'Database is closing' })
        return serializeTransaction(async () => {
            const result = await sendLocal(request)
            const [type, method] = String(request?.method || '').split('.')
            const organizationConfig = organization || request?.organization
            const hasProvider = request?.persistence || organizationConfig?.bootstrapPersistence ||
                organizationConfig?.persistence || organizationConfig?.bootstrapStorage ||
                bootstrapPersistence || Config.get('persistence')
            const hasLocalErrors = Array.isArray(result?.error) ? result.error.length > 0 : Boolean(result?.error)
            if (hasProvider && method === 'read' && result?.success !== false && !hasLocalErrors &&
                !(Array.isArray(result?.[type]) && result[type].length)) {
                const persisted = await sendPersistence(request, {
                    organization: organizationConfig,
                    organizationId: request.organization_id,
                    bootstrapPersistence
                })
                return persisted
            }
            if (hasProvider && type === 'object' && ['create', 'update', 'delete'].includes(method) && result?.success !== false &&
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
                        if (registered?.success === false) throw new Error(registered.error || 'Distribution registration failed')
                    }
                }
            }
            return result
        })
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
    attachPersistenceAPI(db, bootstrapPersistence)
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
                    error: error.message
                }
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
            if (payload.error) pending.reject(new Error(payload.error))
            else pending.resolve(payload.record)
        })
        server.cluster.on('db.partition.request', payload => {
            if (payload.targetId !== server.id || !payload.requesterId || !payload.requestId) return
            Promise.resolve(db.readIndexPartition(payload.path)).then(value => {
                meshSend({
                    method: 'db.partition.response',
                    server: payload.requesterId,
                    requesterId: payload.requesterId,
                    responderId: server.id,
                    requestId: payload.requestId,
                    value
                })
            }).catch(error => {
                meshSend({
                    method: 'db.partition.response',
                    server: payload.requesterId,
                    requesterId: payload.requesterId,
                    responderId: server.id,
                    requestId: payload.requestId,
                    error: error.message
                })
            })
        })
        server.cluster.on('db.partition.response', payload => {
            const pending = partitionRequests.get(payload.requestId)
            if (!pending || pending.nodeId !== payload.responderId || payload.requesterId !== server.id) return
            partitionRequests.delete(payload.requestId)
            clearTimeout(pending.timer)
            if (payload.error) pending.reject(new Error(payload.error))
            else pending.resolve(payload.value)
        })
        server.cluster.on('db.partition.update', payload => {
            if (payload.serverId === server.id) return
            return serializeReplication(() => payload.operation === 'remove'
                ? db.removeIndexPartition(payload.path, { replicated: true })
                : db.applyIndexPartition(payload.path, payload.value, { replicated: true }))
        })
        server.cluster.on('db.storage.mutation', payload => {
            payload = { ...payload, ...payload.scope }
            if (payload.serverId === server.id) return
            return serializeReplication(() => db.applyStorageMutation(payload))
        })
        server.cluster.on('db.object.mutation', payload => {
            payload = { ...payload, ...payload.scope }
            if (payload.serverId === server.id || !Array.isArray(payload.targets) || !payload.targets.includes(server.id)) return
            return serializeReplication(async () => {
                const applied = await db.applyReplicatedObjectMutation(payload)
                if (!applied) return
                const data = { method: 'object.' + (payload.operation === 'remove' ? 'delete' : payload.operation === 'update' ? 'update' : 'create'),
                    organization_id: payload.organization_id, storage: payload.storage, database: payload.database.name, array: payload.array.name,
                    object: [payload.object], success: true, master: false, broadcast: false, server: server.id }
                data.distributionKeys = distributionReferences({ ...payload, databaseId: payload.database._id, arrayId: payload.array._id, objectIds: [payload.object._id] }, true)
                data.worker = [...getDistribution(server.workers.distribution, data.distributionKeys)]
                return data
            }).then(data => data && server.send(data))
                .catch(error => console.error('[CoCreateDB] Peer CRUD delivery failed:', error.message))
        })
        server.cluster.on('db.partition.availability', payload => {
            if (payload.serverId === server.id) return
            const operation = server.send({
                method: 'db.partition.update',
                data: {
                    partitionId: payload.partitionId,
                    nodeId: payload.serverId,
                    operation: payload.operation
                },
                master: true,
                broadcast: false
            })
            return Promise.resolve(operation).catch(error => console.error('[CoCreateDB] Failed to apply a partition availability event:', error))
        })
        server.cluster.on('db.distribution', payload => {
            payload = { ...payload, ...payload.scope }
            return Promise.resolve(server.send({
                data: idsFrom(payload),
                method: 'db.distribution',
                serverId: payload.serverId,
                master: true,
                broadcast: false
            })).catch(error => console.error('[CoCreateDB] Failed to apply a remote availability event:', error))
        })
    }

    return db
}

export default initializeServerDB
