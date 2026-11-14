import { join, resolve } from 'node:path'
import { fileId, identify, newFileId, recordPath, stableId } from './files.js'
import { ensureRoot, readRoot, FORMAT } from './root.js'
import { indexId } from './index/index.js'
import { readdir, rm } from './io.js'
import { ObjectId } from '@cocreate/utils'
import { createDB as createEngine } from './object/index.js'
import createIndex from './index/index.js'
import { createDistributionIndex, distributionReferences } from './distribution.js'
import { createPeerDistribution, createDistributionAdapters, mergeDistributionLists } from './peers.js'
import { createPersistence } from './persistence.js'
import { memoryStats, enableMemoryCache } from './memory.js'
import { auditMetadata, readJSON, replaceJSON } from './storage.js'
import { createRecord, updateRecord, deleteRecord, readRecordById } from './records.js'
import { applyReadFilter } from './read.js'
import { withResolution, resolvedCatalog } from './resolution.js'

function errorHandler(data, error) {
    if (!Array.isArray(data.error)) data.error = data.error === undefined ? [] : [data.error]
    const errors = error?.errors ?? error?.message ?? error
    data.error.push(...(Array.isArray(errors) ? errors : [errors]))
    data.success = false
    return data
}

const id = (value, label) => {
    if (typeof value !== 'string' || !/^[0-9a-f]{24}$/.test(value)) throw new TypeError(`${label} must be a 24-character hexadecimal ObjectId`)
    return value
}
const name = (value, label) => {
    if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a non-empty string`)
    return value
}
const CATALOG = '__catalog__'
const STORAGES = 'storages'

/** Organization-scoped DB service. Unconfigured local data lives in process CWD. */
export function createDB(options = {}) {
    options = { ...options }
    const peers = options.peerDistribution ??= createPeerDistribution(options.nodeId)
    const adapters = createDistributionAdapters(options.nodeId, peers)
    options.distributionAdapter = { ...adapters.distributionAdapter, ...options.distributionAdapter }
    options.partitionAdapter = { ...adapters.partitionAdapter, ...options.partitionAdapter }
    const root = resolve(options.directory ?? process.cwd())
    let queue = Promise.resolve()
    const serialize = operation => {
        const result = queue.then(operation)
        queue = result.catch(() => {})
        return result
    }
    const organizations = new Map()
    const namespaces = new Map()
    if (options.memoryCache || options.memoryOnly || options.disk === false) enableMemoryCache(root, { memoryOnly: options.memoryOnly || options.disk === false })
    const persistence = !options.memoryOnly && options.disk !== false && options.writeBehind ? createPersistence({ ...options.persistenceOptions, directory: root,
        canFlush: () => [...namespaces.values()].every(state => !state.engine.persistenceStats().pendingIndexes) }) : undefined
    const storageFile = (organization, uuid) => recordPath(join(root, organization), 'storages', uuid)
    const context = (organization, record) => ({ organization_id: organization, storageId: record._id, storage: record.name, storageFileId: fileId(record) })

    const organizationState = (organization, incomingRoot) => {
        id(organization, 'organization_id')
        if (organizations.has(organization)) return organizations.get(organization)
        const holders = createDistributionIndex({ directory: join(root, organization, 'distribution', 'root'), maxBytes: options.maxIndexBytes, cache: options.cache, nodeId: options.nodeId })
        const adapter = options.partitionAdapter
        const qualify = path => path.startsWith(`${organization}/`) ? path : `${organization}/${path}`
        const partitions = {
            update: payload => adapter.update({ ...payload, partitionId: qualify(payload.partitionId ?? payload.path) }, holders.updatePartition),
            get: path => adapter.get(qualify(path), holders.getPartition),
            list: () => adapter.list(holders.listPartitions),
            read: adapter.read ? path => adapter.read(qualify(path)) : undefined,
            onLocalChange: payload => {
                const value = { ...payload, nodeId: options.nodeId, path: qualify(payload.path ?? payload.partitionId) }
                return adapter.onLocalChange ? adapter.onLocalChange(value, holders.updatePartition)
                    : holders.updatePartition({ partitionId: value.path, nodeId: options.nodeId, operation: value.operation === 'remove' ? 'remove' : 'add' })
            }
        }
        const index = createIndex({ directory: join(root, organization), indexRoot: join(root, organization),
            maxBytes: options.maxIndexBytes, cache: options.cache,
            resolveArrayDirectory: () => join(root, organization, 'catalogs', 'storages'),
            readPartition: partitions.read,
            onPartitionChange: payload => options.nodeId && partitions.onLocalChange(payload)
        })
        const state = { organization, index, holders, partitions }
        state.ready = incomingRoot ? (async () => {
            await readRoot(join(root, organization))
            await replaceJSON(join(root, organization, 'root.json'), incomingRoot)
            return incomingRoot
        })() : ensureRoot(join(root, organization), index, CATALOG, STORAGES, 'storages', value => options.onRootChange?.({ organization_id: organization, value }))
        state.ready.catch(() => {})
        organizations.set(organization, state)
        return state
    }
    const findStorage = async (organization, storage) => {
        name(storage, 'storage')
        const state = organizationState(organization)
        await state.ready
        const { index } = state
        const existing = resolvedCatalog(index, CATALOG, STORAGES)?.names[storage]
        if (existing) return existing
        for await (const entry of index.scan(CATALOG, STORAGES, 'name', { type: 'string', lower: storage, upper: storage })) {
            if (entry.value !== storage) continue
            const record = await readRecordById(index, CATALOG, STORAGES, uuid => storageFile(organization, uuid), entry.objectId)
            if (record) return record
            const peer = peers.findScope(organization, storage)
            if (peer && options.peerReader) {
                const acquired = await options.peerReader({ ...peer, type: 'storage', fileId: entry.objectId })
                if (acquired) return createRecord(index, CATALOG, STORAGES, storageFile(organization, fileId(acquired)), acquired)
            }
        }
    }
    const createStorage = async (organization, storage, request = {}, storageId, notify = true, uuid = newFileId()) => {
        const existing = await findStorage(organization, storage)
        if (existing) {
            if (storageId && existing._id !== storageId) throw new Error('Storage name resolves to a different stable ID')
            return existing
        }
        const index = organizationState(organization).index
        const record = { _id: storageId ? id(storageId, 'storageId') : ObjectId().toString(), name: storage, created: auditMetadata(request), updated: auditMetadata(request) }
        record.index = indexId(`catalogs/${record._id}/databases`)
        await createRecord(index, CATALOG, STORAGES, storageFile(organization, uuid), record)
        await engineFor(organization, record).engine.ready
        if (notify) await options.onStorageChange?.({ organization_id: organization, storageId: record._id, storageFileId: fileId(record), storage: record.name, operation: 'set', record })
        return record
    }
    const engineFor = (organization, record) => {
        const prefix = `${organization}/storages/${id(record._id, 'storageId')}/`
        if (namespaces.has(prefix)) {
            const existing = namespaces.get(prefix)
            if (record.name) existing.record = record
            return existing
        }
        const state = { organization, record, prefix }
        const scope = () => context(organization, state.record)
        const distribution = options.distributionAdapter
        const engine = createEngine({ ...options, directory: join(root, organization), indexScope: record._id, managedRoot: true,
            indexRoot: join(root, organization),
            sharedPersistence: persistence,
            scheduleIndexing: options.scheduleIndexing ?? serialize,
            persistenceOptions: options.persistenceOptions,
            peerReader: options.peerReader ? payload => options.peerReader({ ...payload, ...scope() }) : undefined,
            documentMutationAdapter: options.documentMutationAdapter ? { publish: payload => options.documentMutationAdapter.publish({ ...payload, ...scope() }) } : undefined,
            onIndexed: options.onIndexed ? payload => options.onIndexed({ ...payload, ...scope() }) : undefined,
            distributionAdapter: {
                update: (payload, apply) => distribution?.update ? distribution.update({ ...payload, ...scope() }, apply) : apply(payload),
                get: (payload, read) => distribution?.get ? distribution.get({ ...payload, ...scope() }, read) : read(payload),
                list: (payload, read) => distribution?.list ? distribution.list({ ...payload, ...scope() }, read) : read(payload),
                onLocalChange: (payload, apply) => distribution?.onLocalChange ? distribution.onLocalChange({ ...payload, ...scope() }, apply) : apply(payload)
            },
            partitionAdapter: organizationState(organization).partitions
        })
        state.engine = engine
        namespaces.set(prefix, state)
        return state
    }
    const byId = async payload => {
        const organization = id(payload.organization_id, 'organization_id')
        const storageId = id(payload.storageId, 'storageId')
        const deleted = await readJSON(join(root, organization, 'deleted', `${stableId('storage:' + storageId)}.json`))
        if (deleted) throw new Error('Storage has been deleted')
        const state = organizationState(organization)
        await state.ready
        let record = await readRecordById(state.index, CATALOG, STORAGES, uuid => storageFile(organization, uuid), payload.storageFileId ?? storageId)
        if (!record && options.peerReader) {
            record = await options.peerReader({ ...payload, type: 'storage', nodeId: payload.nodeId ?? payload.serverId ?? peers.findScope(organization, payload.storage)?.nodeId, fileId: payload.storageFileId })
            if (record) await createRecord(state.index, CATALOG, STORAGES, storageFile(organization, fileId(record)), record)
        }
        if (!record) throw new Error('Storage file not found')
        return engineFor(organization, record)
    }
    const partitionState = path => {
        const match = /^([a-f0-9]{24})\/(indexes\/[a-f0-9]{32}\.json)$/i.exec(path)
        if (!match) throw new TypeError('Invalid scoped index partition path')
        return { ...organizationState(match[1]), path: match[2] }
    }
    const forScope = async (scope, create = false) => {
        const organization = id(scope.organization_id, 'organization_id')
        const record = await findStorage(organization, name(scope.storage, 'storage')) ??
            (create ? await createStorage(organization, scope.storage, scope) : undefined)
        if (!record) {
            const peer = peers.findScope(organization, scope.storage)
            if (peer) return byId(peer)
        }
        return record ? engineFor(organization, record) : undefined
    }
    const flushIndexes = async () => { for (const state of namespaces.values()) await state.engine.flushIndexes() }
    const api = {
        ready: Promise.resolve({ files: 0 }),
        async applyRoots(roots = []) {
            for (const item of roots) {
                const organization = id(item.organization_id, 'organization_id')
                if (item.value?.format !== FORMAT || item.value.storages !== indexId('catalogs/storages'))
                    throw new Error('Invalid organization root')
                const state = organizationState(organization, item.value)
                await state.ready
                const path = `indexes/${item.value.storages}.json`
                const local = await state.index.readPartition(path)
                if (local && !local.catalogLength) {
                    await state.index.removePartition(path)
                    if (options.nodeId) await state.partitions.onLocalChange({ path, operation: 'remove', acquired: true })
                }
                await replaceJSON(join(root, organization, 'root.json'), item.value)
            }
        },
        distribution: {
            local: {
                async snapshot() {
                    // Enumerate namespace catalogs and saved holder indexes, not object files.
                    let entries = []
                    try { entries = await readdir(root) } catch (error) { if (error.code !== 'ENOENT') throw error }
                    const ids = new Set([...organizations.keys(), ...entries.filter(value => /^[a-f0-9]{24}$/.test(value))])
                    const entities = [], partitions = []
                    for (const organization of ids) {
                        const state = organizationState(organization)
                        await state.ready
                        for await (const entry of state.index.scan(CATALOG, STORAGES, '_id', { type: 'string' })) {
                            const record = await readRecordById(state.index, CATALOG, STORAGES, uuid => storageFile(organization, uuid), entry.objectId)
                            if (record) {
                                entities.push(context(organization, record))
                                engineFor(organization, record)
                            }
                        }
                        partitions.push(...await state.holders.listPartitions())
                    }
                    for (const state of namespaces.values()) {
                        const local = state.engine.distribution.local
                        const scope = context(state.organization, state.record)
                        for (const database of await local.list()) {
                            const db = await state.engine.readLocalEntity({ type: 'database', databaseId: database.id })
                            const dbScope = { ...scope, databaseId: database.id, databaseFileId: fileId(db), databaseIndex: db?.index }
                            entities.push(dbScope)
                            for (const array of await local.list({ databaseId: database.id })) {
                                const metadata = await state.engine.readLocalEntity({ type: 'array', databaseId: database.id, arrayId: array.id })
                                const arrayScope = { ...dbScope, arrayId: array.id, arrayFileId: fileId(metadata), arrayIndex: metadata?.index }
                                entities.push(arrayScope)
                                for (const object of await local.list({ databaseId: database.id, arrayId: array.id }))
                                    entities.push({ ...arrayScope, objectId: object.id })
                            }
                        }
                    }
                    const roots = []
                    for (const organization of ids) roots.push({ organization_id: organization, value: await organizationState(organization).ready })
                    return { roots, entities, partitions: partitions.map(({ partitionId }) => ({ partitionId })) }
                }
            },
            peers: options.peerDistribution
        },
        async forScope(scope) { return (await forScope(scope))?.engine },
        hydrateObjects: (request, records) => serialize(async () => {
            const state = await forScope(request, records.length > 0)
            if (state) await state.engine.hydrateObjects(request, records)
        }),
        memoryStats: () => memoryStats(root),
        clearDistributionCache() {
            for (const state of organizations.values()) state.holders.clearCache()
            for (const state of namespaces.values()) state.engine.clearDistributionCache()
        },
        holdPersistence: () => persistence?.hold(),
        persistenceStats: () => ({ ...persistence?.stats(), pendingIndexes: [...namespaces.values()].reduce((sum, state) => sum + state.engine.persistenceStats().pendingIndexes, 0) }),
        flushIndexes: () => serialize(flushIndexes),
        flushPersistence: () => persistence?.flush(),
        async flush() { await api.flushIndexes(); await persistence?.flush() },
        async close() { await api.flush(); for (const state of namespaces.values()) await state.engine.close(); await persistence?.close() },
        async send(request) {
            const response = { ...request }
            if (request.method === 'object.update')
                for (const key of Object.keys(response)) if (key.startsWith('$') && key !== '$update') delete response[key]
            const release = persistence?.hold()
            try {
                const organization = id(request.organization_id, 'organization_id')
                const storage = name(request.storage, 'storage')
                name(request.database, 'database')
                const [type, method] = String(request.method).split('.')
                if (!['storage', 'database', 'array', 'index', 'object'].includes(type) || !['create', 'read', 'update', 'delete'].includes(method))
                    throw new Error(`Unsupported CRUD method: ${request.method}`)
                if (type === 'object') name(request.array, 'array')
                if (type === 'storage') {
                    const state = organizationState(organization)
                    let record = await findStorage(organization, storage)
                    if (method === 'create') record = await createStorage(organization, storage, request, request.storageId)
                    else if (method === 'update') {
                        if (!record) throw new Error('Storage not found')
                        const renamed = name(request.name ?? request.newName, 'storage name')
                        const conflict = await findStorage(organization, renamed)
                        if (conflict && conflict._id !== record._id) throw new Error('Storage name already exists')
                        record = await updateRecord(state.index, CATALOG, STORAGES, storageFile(organization, fileId(record)), record,
                            value => { value.name = renamed; value.updated = auditMetadata(request) })
                        const loaded = namespaces.get(`${organization}/storages/${record._id}/`)
                        if (loaded) loaded.record = record
                        await options.onStorageChange?.({ ...context(organization, record), operation: 'set', record })
                    } else if (method === 'delete') {
                        if (record) {
                            const loaded = engineFor(organization, record)
                            await loaded.engine.flushIndexes()
                            await loaded.engine.dropIndexes()
                            await deleteRecord(state.index, CATALOG, STORAGES, storageFile(organization, fileId(record)), record)
                            await rm(storageFile(organization, fileId(record)), { force: true })
                            await replaceJSON(join(root, organization, 'deleted', `${stableId('storage:' + record._id)}.json`), { _id: record._id, name: record.name })
                            namespaces.delete(loaded.prefix)
                            await options.onStorageChange?.({ ...context(organization, record), operation: 'remove', record })
                        }
                    } else if (method !== 'read') throw new Error('Unsupported storage method')
                    response.storage = applyReadFilter(record ? [record] : [], request, { database: request.database, array: STORAGES, query: request.filter?.query ?? {} })
                    for (const item of response.storage) item.$storage = [item.name]
                    response.success = true
                    return response
                }
                const state = await forScope(request, method === 'create' || (method === 'update' && request.upsert))
                if (!state) return { ...response, [type]: [], success: true }
                const result = await state.engine.send(request)
                result.storageId = state.record._id
                for (const item of Array.isArray(result[type]) ? result[type] : []) if (item.$storage) item.$storage = [storage]
                return result
            } catch (error) { return errorHandler(response, error) }
            finally { release?.() }
        },
        async applyStorageMutation(payload) {
            return serialize(async () => {
                const organization = id(payload.organization_id, 'organization_id')
                const storageId = id(payload.storageId, 'storageId')
                const record = payload.record
                if (!record || record._id !== storageId || !['set', 'remove'].includes(payload.operation)) throw new Error('Invalid storage mutation')
                name(record.name, 'storage')
                identify(record, payload.storageFileId ?? fileId(record))
                const file = storageFile(organization, fileId(record))
                const state = organizationState(organization)
                await state.ready
                const { index } = state
                const current = await readRecordById(index, CATALOG, STORAGES, uuid => storageFile(organization, uuid), fileId(record))
                if (payload.operation === 'remove') {
                    const loaded = engineFor(organization, current ?? record)
                    await loaded.engine.flushIndexes()
                    await loaded.engine.dropIndexes()
                    if (current) await deleteRecord(index, CATALOG, STORAGES, file, current)
                    await rm(file, { force: true })
                    await replaceJSON(join(root, organization, 'deleted', `${stableId('storage:' + storageId)}.json`), { _id: storageId, name: record.name })
                    if (loaded) namespaces.delete(loaded.prefix)
                } else {
                    if (await readJSON(join(root, organization, 'deleted', `${stableId('storage:' + storageId)}.json`))) return false
                    const conflict = await findStorage(organization, record.name)
                    if (conflict && conflict._id !== storageId) throw new Error('Conflicting storage reference')
                    if (current) await updateRecord(index, CATALOG, STORAGES, file, current, record)
                    else await createRecord(index, CATALOG, STORAGES, file, record)
                    const loaded = namespaces.get(`${organization}/storages/${storageId}/`)
                    if (loaded) loaded.record = current ?? record
                }
                return true
            })
        },
        async updateDistribution(payload) {
            if (options.peerDistribution && payload.nodeId !== options.nodeId) return options.peerDistribution.update(payload)
            return (await byId(payload)).engine.updateDistribution(payload)
        },
        async getDistribution(payload) { return (await byId(payload)).engine.getDistribution(payload) },
        async listDistribution(payload) { return (await byId(payload)).engine.listDistribution(payload) },
        async readLocalEntity(payload) {
            if (payload.type === 'value') {
                const value = await readJSON(recordPath(join(root, id(payload.organization_id, 'organization_id')), 'values', payload.fileId))
                return value && identify(value, payload.fileId)
            }
            if (payload.type === 'storage') {
                const state = organizationState(id(payload.organization_id, 'organization_id'))
                await state.ready
                return readRecordById(state.index, CATALOG, STORAGES, uuid => storageFile(payload.organization_id, uuid), payload.fileId ?? payload.storageFileId ?? payload.storageId)
            }
            return (await byId(payload)).engine.readLocalEntity(payload)
        },
        async applyReplicatedObjectMutation(payload) { return (await byId(payload)).engine.applyReplicatedObjectMutation(payload) },
        async updatePartition(payload) {
            if (options.peerDistribution && payload.nodeId !== options.nodeId) return options.peerDistribution.updatePartition(payload)
            const target = partitionState(payload.partitionId ?? payload.path)
            return target.partitions.update(payload)
        },
        async getPartitionHolders(path) {
            const target = partitionState(path)
            return target.partitions.get(path)
        },
        async listPartitions() {
            const result = []
            for (const state of organizations.values()) result.push(...await state.holders.listPartitions())
            return mergeDistributionLists(result, peers.listPartitions(), 'partitionId')
        },
        async readIndexPartition(path) {
            const target = partitionState(path)
            await target.ready
            return target.index.readPartition(target.path)
        },
        async applyIndexPartition(path, value, options) {
            const target = partitionState(path)
            await target.ready
            const node = await target.index.applyPartition(target.path, value)
            await target.partitions.onLocalChange({ path, value: node, operation: 'set', acquired: !options?.replicated, replicated: options?.replicated })
            return node
        },
        async removeIndexPartition(path, options) {
            const target = partitionState(path)
            await target.ready
            await target.index.removePartition(target.path)
            await target.partitions.onLocalChange({ path, operation: 'remove', acquired: !options?.replicated, replicated: options?.replicated })
        }
    }
    const send = api.send.bind(api)
    api.send = request => serialize(() => withResolution(async () => {
        const [type, method] = String(request.method).split('.')
        const fast = (options.writeBehind || options.memoryOnly || options.disk === false) && type === 'object'
        // Resolve before deletion/rename, and after creation, using the same entity IDs as node distribution.
        let state, ids
        try {
            if (type !== 'storage') {
                state = await forScope(request)
                if (state && !fast) ids = await state.engine.resolveDistributionIds({ database: request.database, array: request.array })
            }
        } catch { /* send() returns the normal validation error envelope. */ }
        const result = await send(request)
        delete result.distribution
        delete result.distributionKeys
        if (result.success !== false && !(Array.isArray(result.error) ? result.error.length : result.error)) {
            state ??= type === 'storage' ? undefined : await forScope(request)
            if (state && fast) ids = state.engine.resolvedScope(request)
            else if (state && method === 'create') ids = await state.engine.resolveDistributionIds({ database: request.database, array: request.array })
            const storageId = state?.record._id ?? result.storage?.[0]?._id
            const address = { ...ids, organization_id: request.organization_id, storageId, type,
                storageFileId: fileId(state?.record ?? result.storage?.[0]) }
            const objects = value => (Array.isArray(value) ? value : [value]).map(fileId).filter(Boolean)
            result.distribution = distributionReferences({ ...address, objectIds: objects(result.object) }, Boolean(request.filter) || !objects(result.object).length)
            result.distributionKeys = distributionReferences({ ...address, objectIds: objects(result.object) }, method !== 'read')
        }
        return result
    }))
    api.index = Object.fromEntries(['read', 'getMetadata', 'create', 'update', 'delete'].map(method => [method, async (scope, ...args) => {
        const state = await forScope(scope, method === 'create' || method === 'update')
        if (!state) return undefined
        return state.engine.index[method](...args)
    }]))
    api.index.clearCache = () => {
        for (const state of organizations.values()) state.index.clearCache()
        for (const state of namespaces.values()) state.engine.index.clearCache()
    }
    api.index.scan = async function* (scope, ...args) {
        const state = await forScope(scope)
        if (state) yield* state.engine.index.scan(...args)
    }
    return api
}
