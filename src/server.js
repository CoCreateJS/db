import { createDB } from './object/index.js'

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
    cache = false
} = {}) {
    if (!server?.id || typeof server.send !== 'function')
        throw new TypeError('A initialized CoCreate server with an id and send() is required')

    let db

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

    const distributedAdapter = server.isPrimary
        ? {
            update: (payload, apply) => apply(payload),
            get: (payload, read) => read(payload),
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
            onLocalChange: payload => requestPrimary('db.distributed.local', { data: idsFrom(payload) })
        }

    db = createDB({
        directory,
        maxIndexBytes,
        cache,
        nodeId: server.id,
        distributedAdapter
    })

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
        server.on('db.distributed', payload => db.updateDistributed(idsFrom(payload.data ?? payload)))
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
