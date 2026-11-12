import { createDB } from './object/index.js'
import { randomUUID } from 'node:crypto'

export const DB_PROVIDER = 'cocreate-db'

function idsFrom(payload) {
    return {
        databaseId: payload.databaseId,
        arrayId: payload.arrayId,
        objectId: payload.objectId,
        nodeId: payload.nodeId,
        operation: payload.operation
    }
}

/** Attach a filesystem CoCreateDB instance and its primary-owned availability writer. */
export function initializeServerDB(server, {
    directory = process.env.COCREATE_DB_DIRECTORY || './.cocreate/db',
    maxIndexBytes,
    cache = false,
    memoryCache = true,
    peerTimeoutMs = 5000
} = {}) {
    if (!server?.id || typeof server.send !== 'function')
        throw new TypeError('A initialized CoCreate server with an id and send() is required')

    let db
    const peerRequests = new Map()
    const partitionRequests = new Map()
    let replicationQueue = Promise.resolve()
    const serializeReplication = operation => {
        const result = replicationQueue.then(operation)
        replicationQueue = result.catch(error => console.error('[CoCreateDB] Failed to apply a replication event:', error))
        return replicationQueue
    }

    const readFromPeer = ({ nodeId, ...entity }) => {
        if (nodeId === server.id) return db.readLocalEntity(entity)
        if (!server.isPrimary)
            return requestPrimary('db.peer.fetch', { data: { nodeId, ...entity } })

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
                server.cluster.send({
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

    const requestPrimary = async (method, payload = {}) => {
        const response = await server.send({
            method,
            ...payload,
            master: true,
            broadcast: false
        })
        if (response?.success === false) throw new Error(response.error || `${method} failed`)
        return response?.result
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
                server.cluster.send({
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
        if (!server.isPrimary)
            return requestPrimary('db.partition.acquire', { data: { path } })
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
            server.cluster.send({
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
                server.cluster.send({
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

    const partitionAdapter = server.isPrimary
        ? {
            update: (payload, apply) => apply(payload),
            get: (path, read) => read(path),
            list: read => read(),
            onLocalChange: localPartitionChange,
            read: readPartitionFromPeers
        }
        : {
            update: payload => requestPrimary('db.partition.update', { data: payload }),
            get: path => requestPrimary('db.partition.get', { data: { path } }),
            list: () => requestPrimary('db.partition.list'),
            onLocalChange: payload => requestPrimary('db.partition.local', { data: payload }),
            read: readPartitionFromPeers
        }

    const documentMutationAdapter = {
        publish: mutation => {
            for (const targetId of mutation.targets) {
                server.cluster.send({
                    method: 'db.object.mutation',
                    server: targetId,
                    serverId: server.id,
                    ...mutation
                })
            }
        }
    }

    const distributedAdapter = server.isPrimary
        ? {
            update: (payload, apply) => apply(payload),
            get: (payload, read) => read(payload),
            list: (payload, read) => read(payload),
            onLocalChange: async (payload, apply) => {
                const result = await apply(payload)
                if (result.changed) {
                    server.cluster.send({
                        method: 'db.distributed',
                        broadcast: true,
                        workers: false,
                        serverId: server.id,
                        ...idsFrom(payload)
                    })
                }
                return result
            }
        }
        : {
            update: payload => requestPrimary('db.distributed.update', { data: idsFrom(payload) }),
            get: payload => requestPrimary('db.distributed.get', { data: payload }),
            list: payload => requestPrimary('db.distributed.list', { data: payload }),
            onLocalChange: payload => requestPrimary('db.distributed.local', { data: idsFrom(payload) })
        }

    db = createDB({
        directory,
        maxIndexBytes,
        cache,
        memoryCache,
        nodeId: server.id,
        distributedAdapter,
        peerReader: readFromPeer,
        partitionAdapter,
        documentMutationAdapter
    })
    if (memoryCache)
        console.info('[CoCreateDB] On-demand memory cache enabled; no startup preloading')

    const sendLocal = db.send.bind(db)
    let writeQueue = Promise.resolve()
    const serializeWrite = operation => {
        const result = writeQueue.then(operation)
        writeQueue = result.catch(() => {})
        return result
    }
    const isWrite = request => ['create', 'update', 'delete'].includes(request?.method?.split('.')?.[1])
    db.send = request => {
        if (!isWrite(request)) return sendLocal(request)
        return server.isPrimary
            ? serializeWrite(() => sendLocal(request))
            : requestPrimary('db.send', { data: request })
    }

    server.DB = db

    if (server.isPrimary) {
        server.on('db.send', async payload => {
            const result = await serializeWrite(() => sendLocal(payload.data))
            return { ...payload, success: result.success !== false, result }
        })

        const localChange = async payload => {
            const result = await db.updateDistributed(idsFrom(payload.data ?? payload))
            if (result.changed) {
                server.cluster.send({
                    method: 'db.distributed',
                    broadcast: true,
                    workers: false,
                    serverId: server.id,
                    ...idsFrom(payload.data ?? payload)
                })
            }
            return { ...payload, success: true, result }
        }

        server.on('db.distributed.local', localChange)
        server.on('db.distributed.update', async payload => ({
            ...payload,
            success: true,
            result: await db.updateDistributed(idsFrom(payload.data ?? payload))
        }))
        server.on('db.distributed.get', async payload => ({
            ...payload,
            success: true,
            result: await db.getDistributed(payload.data ?? payload)
        }))
        server.on('db.distributed.list', async payload => ({
            ...payload,
            success: true,
            result: await db.listDistributed(payload.data ?? payload)
        }))
        server.on('db.partition.update', async payload => ({
            ...payload,
            success: true,
            result: await db.updatePartition(payload.data ?? payload)
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
            return { ...payload, success: true, result: await localPartitionChange(data, db.updatePartition) }
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
        server.on('db.distributed', payload => db.updateDistributed(idsFrom(payload.data ?? payload)))
        server.cluster.on('db.document.request', payload => {
            if (payload.targetId !== server.id || !payload.requesterId || !payload.requestId) return
            Promise.resolve(db.readLocalEntity(payload)).then(record => {
                const response = {
                    requesterId: payload.requesterId,
                    responderId: server.id,
                    requestId: payload.requestId,
                    record
                }
                server.cluster.send({
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
                server.cluster.send({
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
                server.cluster.send({
                    method: 'db.partition.response',
                    server: payload.requesterId,
                    requesterId: payload.requesterId,
                    responderId: server.id,
                    requestId: payload.requestId,
                    value
                })
            }).catch(error => {
                server.cluster.send({
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
            serializeReplication(() => payload.operation === 'remove'
                ? db.removeIndexPartition(payload.path, { replicated: true })
                : db.applyIndexPartition(payload.path, payload.value, { replicated: true }))
        })
        server.cluster.on('db.object.mutation', payload => {
            if (payload.serverId === server.id || !Array.isArray(payload.targets) || !payload.targets.includes(server.id)) return
            serializeReplication(() => db.applyReplicatedObjectMutation(payload))
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
            Promise.resolve(operation).catch(error => console.error('[CoCreateDB] Failed to apply a partition availability event:', error))
        })
        server.cluster.on('db.distributed', payload => {
            Promise.resolve(server.send({
                ...idsFrom(payload),
                method: 'db.distributed',
                serverId: payload.serverId,
                master: true,
                broadcast: false
            })).catch(error => console.error('[CoCreateDB] Failed to apply a remote availability event:', error))
        })
    }

    return db
}

export default initializeServerDB
