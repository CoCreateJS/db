import { join, resolve } from 'node:path'
import { ObjectId } from '@cocreate/utils'
import { createDB as createEngine } from './object/index.js'
import createIndex from './index/index.js'
import { createDistributionIndex, distributionReferences } from './distribution.js'
import { createPersistence } from './persistence.js'
import { memoryStats, enableMemoryCache } from './memory.js'
import { auditMetadata, readJSON, replaceJSON, removeDirectoryPreservingDistribution } from './storage.js'
import { createRecord, updateRecord, deleteRecord } from './records.js'
import { applyReadFilter } from './read.js'
import { live } from './mutation.js'

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
    const root = resolve(options.directory ?? process.cwd())
    let queue = Promise.resolve()
    const serialize = operation => {
        const result = queue.then(operation)
        queue = result.catch(() => {})
        return result
    }
    const organizations = new Map()
    const namespaces = new Map()
    if (options.memoryCache || options.memoryOnly) enableMemoryCache(root, { memoryOnly: options.memoryOnly })
    const persistence = !options.memoryOnly && options.writeBehind ? createPersistence({ ...options.persistenceOptions, directory: root,
        canFlush: () => [...namespaces.values()].every(state => !state.engine.persistenceStats().pendingIndexes) }) : undefined
    const storageFile = (organization, storageId) => join(root, organization, 'storages', storageId, 'storage.json')
    const context = (organization, record) => ({ organization_id: organization, storageId: record._id, storage: record.name })

    const organizationState = organization => {
        id(organization, 'organization_id')
        if (organizations.has(organization)) return organizations.get(organization)
        const holders = createDistributionIndex({ directory: join(root, organization, 'storages'), maxBytes: options.maxIndexBytes, cache: options.cache })
        const index = createIndex({ directory: root, maxBytes: options.maxIndexBytes, cache: options.cache,
            resolveArrayDirectory: () => join(root, organization, 'storages'),
            readPartition: path => options.partitionAdapter?.read?.(path),
            onPartitionChange: payload => {
                if (!options.nodeId) return
                return options.partitionAdapter?.onLocalChange
                    ? options.partitionAdapter.onLocalChange({ ...payload, nodeId: options.nodeId }, holders.updatePartition)
                    : holders.updatePartition({ partitionId: payload.path, nodeId: options.nodeId, operation: payload.operation === 'remove' ? 'remove' : 'add' })
            }
        })
        const state = { organization, index, holders }
        organizations.set(organization, state)
        return state
    }
    const findStorage = async (organization, storage) => {
        name(storage, 'storage')
        const { index } = organizationState(organization)
        for await (const entry of index.scan(CATALOG, STORAGES, 'name', { type: 'string', lower: storage, upper: storage })) {
            if (entry.value === storage) return live(await readJSON(storageFile(organization, entry.objectId)))
        }
    }
    const createStorage = async (organization, storage, request = {}, storageId, notify = true) => {
        const existing = await findStorage(organization, storage)
        if (existing) {
            if (storageId && existing._id !== storageId) throw new Error('Storage name resolves to a different stable ID')
            return existing
        }
        const index = organizationState(organization).index
        const record = { _id: storageId ? id(storageId, 'storageId') : ObjectId().toString(), name: storage,
            created: auditMetadata(request), updated: auditMetadata(request) }
        await createRecord(index, CATALOG, STORAGES, storageFile(organization, record._id), record)
        if (notify) await options.onStorageChange?.({ organization_id: organization, storageId: record._id, storage: record.name, operation: 'set', record })
        return record
    }
    const qualify = (prefix, path) => path.startsWith(prefix) ? path : prefix + path
    const engineFor = (organization, record) => {
        const prefix = `${organization}/storages/${id(record._id, 'storageId')}/`
        if (namespaces.has(prefix)) {
            const existing = namespaces.get(prefix)
            if (record.name) existing.record = record
            return existing
        }
        const state = { organization, record, prefix }
        const scope = () => context(organization, state.record)
        const adapter = options.partitionAdapter
        const distribution = options.distributionAdapter
        const engine = createEngine({ ...options, directory: join(root, organization, 'storages', record._id),
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
            partitionAdapter: {
                update: (payload, apply) => {
                    const value = { ...payload, partitionId: qualify(prefix, payload.partitionId ?? payload.path) }
                    return adapter?.update ? adapter.update(value, apply) : apply(value)
                },
                get: (path, read) => adapter?.get ? adapter.get(qualify(prefix, path), read) : read(qualify(prefix, path)),
                list: read => adapter?.list ? adapter.list(read) : read(),
                read: adapter?.read ? path => adapter.read(qualify(prefix, path)) : undefined,
                onLocalChange: (payload, apply) => {
                    const value = { ...payload, path: qualify(prefix, payload.path ?? payload.partitionId) }
                    return adapter?.onLocalChange ? adapter.onLocalChange(value, apply)
                        : apply({ partitionId: value.path, nodeId: options.nodeId, operation: value.operation === 'remove' ? 'remove' : 'add' })
                }
            }
        })
        state.engine = engine
        namespaces.set(prefix, state)
        return state
    }
    const byId = async payload => {
        const organization = id(payload.organization_id, 'organization_id')
        const storageId = id(payload.storageId, 'storageId')
        const deleted = await readJSON(join(root, organization, 'storages', 'deleted', `${storageId}.json`))
        if (deleted) throw new Error('Storage has been deleted')
        let record = await readJSON(storageFile(organization, storageId))
        if (!record && payload.storage) record = await createStorage(organization, payload.storage, {}, storageId, false)
        if (!record) record = { _id: storageId, name: payload.storage }
        return engineFor(organization, record)
    }
    const parsePartition = path => {
        if (typeof path !== 'string' || path.includes('\\') || path.includes('\0')) throw new TypeError('Invalid scoped index partition path')
        const parts = path.split('/')
        id(parts[0], 'organization_id')
        if (parts[1] !== 'storages' || parts.some(part => !part || part === '.' || part === '..')) throw new TypeError('Invalid scoped index partition path')
        return { organization: parts[0], storageId: parts[2] === 'index' ? undefined : id(parts[2], 'storageId'), path }
    }
    const partitionState = async path => {
        const target = parsePartition(path)
        return target.storageId ? { ...target, state: await byId({ organization_id: target.organization, storageId: target.storageId }) }
            : { ...target, state: organizationState(target.organization) }
    }
    const forScope = async (scope, create = false) => {
        const organization = id(scope.organization_id, 'organization_id')
        const record = await findStorage(organization, name(scope.storage, 'storage')) ??
            (create ? await createStorage(organization, scope.storage, scope) : undefined)
        return record ? engineFor(organization, record) : undefined
    }
    const flushIndexes = async () => { for (const state of namespaces.values()) await state.engine.flushIndexes() }
    const api = {
        ready: Promise.resolve({ files: 0 }),
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
                for (const key of Object.keys(response)) if (key.startsWith('$')) delete response[key]
            const release = persistence?.hold()
            try {
                const organization = id(request.organization_id, 'organization_id')
                const storage = name(request.storage, 'storage')
                name(request.database, 'database')
                const [type, method] = String(request.method).split('.')
                if (!['storage', 'database', 'array', 'object'].includes(type) || !['create', 'read', 'update', 'delete'].includes(method))
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
                        record = await updateRecord(state.index, CATALOG, STORAGES, storageFile(organization, record._id), record,
                            { ...record, name: renamed, updated: auditMetadata(request) })
                        const loaded = namespaces.get(`${organization}/storages/${record._id}/`)
                        if (loaded) loaded.record = record
                        await options.onStorageChange?.({ ...context(organization, record), operation: 'set', record })
                    } else if (method === 'delete') {
                        if (record) {
                            const loaded = engineFor(organization, record)
                            await loaded.engine.flushIndexes()
                            await deleteRecord(state.index, CATALOG, STORAGES, storageFile(organization, record._id), record)
                            await removeDirectoryPreservingDistribution(root, join(root, organization, 'storages', record._id))
                            await replaceJSON(join(root, organization, 'storages', 'deleted', `${record._id}.json`), { _id: record._id, name: record.name })
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
            } catch (error) { return { ...response, success: false, error: error.message } }
            finally { release?.() }
        },
        async applyStorageMutation(payload) {
            return serialize(async () => {
                const organization = id(payload.organization_id, 'organization_id')
                const storageId = id(payload.storageId, 'storageId')
                const record = payload.record
                if (!record || record._id !== storageId || !['set', 'remove'].includes(payload.operation)) throw new Error('Invalid storage mutation')
                name(record.name, 'storage')
                const file = storageFile(organization, storageId)
                const current = await readJSON(file)
                const index = organizationState(organization).index
                if (payload.operation === 'remove') {
                    const loaded = namespaces.get(`${organization}/storages/${storageId}/`)
                    if (loaded) await loaded.engine.flushIndexes()
                    if (current) await deleteRecord(index, CATALOG, STORAGES, file, current)
                    await removeDirectoryPreservingDistribution(root, join(root, organization, 'storages', storageId))
                    await replaceJSON(join(root, organization, 'storages', 'deleted', `${storageId}.json`), { _id: storageId, name: record.name })
                    if (loaded) namespaces.delete(loaded.prefix)
                } else {
                    if (await readJSON(join(root, organization, 'storages', 'deleted', `${storageId}.json`))) return false
                    const conflict = await findStorage(organization, record.name)
                    if (conflict && conflict._id !== storageId) throw new Error('Conflicting storage reference')
                    if (current) await updateRecord(index, CATALOG, STORAGES, file, current, record)
                    else await createRecord(index, CATALOG, STORAGES, file, record)
                    const loaded = namespaces.get(`${organization}/storages/${storageId}/`)
                    if (loaded) loaded.record = record
                }
                return true
            })
        },
        async updateDistribution(payload) { return (await byId(payload)).engine.updateDistribution(payload) },
        async getDistribution(payload) { return (await byId(payload)).engine.getDistribution(payload) },
        async listDistribution(payload) { return (await byId(payload)).engine.listDistribution(payload) },
        async readLocalEntity(payload) {
            if (payload.type === 'storage') return readJSON(storageFile(id(payload.organization_id, 'organization_id'), id(payload.storageId, 'storageId')))
            return (await byId(payload)).engine.readLocalEntity(payload)
        },
        async applyReplicatedObjectMutation(payload) { return (await byId(payload)).engine.applyReplicatedObjectMutation(payload) },
        async updatePartition(payload) {
            const target = await partitionState(payload.partitionId ?? payload.path)
            return target.storageId ? target.state.engine.updatePartition(payload) : target.state.holders.updatePartition(payload)
        },
        async getPartitionHolders(path) {
            const target = await partitionState(path)
            return target.storageId ? target.state.engine.getPartitionHolders(path) : target.state.holders.getPartition(path)
        },
        async listPartitions() {
            const result = []
            for (const state of organizations.values()) result.push(...await state.holders.listPartitions())
            for (const state of namespaces.values()) result.push(...await state.engine.listPartitions())
            return result
        },
        async readIndexPartition(path) {
            const target = await partitionState(path)
            return target.storageId ? target.state.engine.readIndexPartition(path.slice(target.state.prefix.length)) : target.state.index.readPartition(path)
        },
        async applyIndexPartition(path, value, options) {
            const target = await partitionState(path)
            return target.storageId ? target.state.engine.applyIndexPartition(path.slice(target.state.prefix.length), value, options) : target.state.index.applyPartition(path, value)
        },
        async removeIndexPartition(path, options) {
            const target = await partitionState(path)
            return target.storageId ? target.state.engine.removeIndexPartition(path.slice(target.state.prefix.length), options) : target.state.index.removePartition(path)
        }
    }
    const send = api.send.bind(api)
    api.send = request => serialize(async () => {
        const [type, method] = String(request.method).split('.')
        // Resolve before deletion/rename, and after creation, using the same entity IDs as node distribution.
        let state, ids
        try {
            if (type !== 'storage') {
                state = await forScope(request)
                if (state) ids = await state.engine.resolveDistributionIds({ database: request.database, array: request.array })
            }
        } catch { /* send() returns the normal validation error envelope. */ }
        const result = await send(request)
        delete result.distribution
        delete result.distributionKeys
        if (result.success !== false && !(Array.isArray(result.error) ? result.error.length : result.error)) {
            state ??= type === 'storage' ? undefined : await forScope(request)
            if (state && method === 'create') ids = await state.engine.resolveDistributionIds({ database: request.database, array: request.array })
            const storageId = state?.record._id ?? result.storage?.[0]?._id
            const address = { ...ids, organization_id: request.organization_id, storageId, type }
            const objects = value => (Array.isArray(value) ? value : [value])
                .map(item => typeof item === 'string' ? item : item?._id).filter(Boolean)
            const requested = objects(request.object)
            result.distribution = distributionReferences({ ...address, objectIds: [...new Set([...requested, ...objects(result.object)])] }, Boolean(request.filter) || !requested.length)
            result.distributionKeys = distributionReferences({ ...address, objectIds: objects(result.object) }, method !== 'read')
        }
        return result
    })
    api.index = Object.fromEntries(['get', 'getMetadata', 'set', 'remove'].map(method => [method, async (scope, ...args) => {
        const state = await forScope(scope, method === 'set')
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
