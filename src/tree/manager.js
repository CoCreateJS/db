import { uuid, getValueFromObject, dotNotationToObject } from '@cocreate/utils'
import { defer, cancelDefer } from './defer.js'
import { createLeaf, initializeLeaf, bindIndexRestore, hasIndexEntry, attachIndexEntry, indexValues, type, deferLeaf, reconcileLeaf, removeIndexedEntry } from './leaf.js'
import getLeaves from './query.js'
import { Tree as IndexTree } from './btree.js'

const uuidValue = () => uuid().replaceAll('-', '')
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const STOP = Symbol.for('cocreate.db.tree.stop')
const INDEX_BATCH_SIZE = 1024

function rootPaths(roots, target) {
    const result = []
    const visit = (node, path, parents) => {
        if (!isRecord(node)) throw new TypeError('Each root configuration node must be an object')
        if (parents.has(node)) throw new Error('Cyclic root configuration')
        parents.add(node)
        for (const [name, child] of Object.entries(node)) {
            if (['__proto__','constructor','prototype'].includes(name)) throw Error('Invalid root name')
            if (name === '$') throw new Error('Invalid dynamic root name')
            const next = [...path, name]
            if (name === target) result.push(next)
            if (isRecord(child)) visit(child, next, parents)
            else throw new TypeError(`Root ${name} must contain an object`)
        }
        parents.delete(node)
    }
    visit(roots, [], new WeakSet())
    return result
}

function reference(envelope, name) {
    const key = name.startsWith('$') ? name.slice(1) : name
    const value = Object.hasOwn(envelope, key) ? envelope[key] : undefined
    if (typeof value === 'string' && value) return { name: value }
    if (isRecord(value)) {
        if (typeof value.uuid === 'string' && value.uuid) return { uuid: value.uuid }
        if (typeof value.name === 'string' && value.name) return { name: value.name }
    }
}

function indexTree(tree, size, leafSize, entry, local, leaves, catalog) {
    const parent = entry.leaf ? (entry.leaf.parent ?? entry.leaf.uuid) : entry.tree?.primary
    let fields = tree.get(parent)
    if (!fields) tree.set(parent, fields = new Map())
    let types = fields.get(entry.key)
    if (!types) fields.set(entry.key, types = new Map())
    let index = types.get(type(entry.value))
    if (!index) {
        const route = catalog.find(route => route.primary === parent && route.key === entry.key && route.type === type(entry.value))
        types.set(type(entry.value), index = new IndexTree(size,local,entry.key,leafSize,route?.uuid))
        index.route = route ?? { primary: parent, key: entry.key, type: type(entry.value), uuid: index.root.uuid }
        if (!route) catalog.push(index.route)
        index.primary = parent
        index.valueType = type(entry.value)
        index.resolveLeaf = async id => await leaves.get(id)
    }
    return index
}

async function insertEntry(tree, size, leafSize, entry, local, leaves, catalog) {
    const index = indexTree(tree, size, leafSize, entry, local, leaves, catalog)
    await entry.insert(index)
}

export async function createRootManager({ db, size = 1024, leafSize = size, persistConfig = () => {}, persist, onIdle = () => {}, canPrune = () => false }) {
    const pendingChanges = Object.create(null)
    const inFlight = Object.create(null)
    let queuedCount = 0
    let pendingCount = 0
    const branchId = leaf => leaf.parent ?? leaf.uuid
    const queued = leaf => pendingChanges[branchId(leaf)]?.[leaf.uuid]
    const pendingIndex = Object.freeze({
        get size() { return pendingCount },
        has(leaf) { return !!queued(leaf) || Object.hasOwn(inFlight, leaf.uuid) },
        toJSON() {
            const snapshot = Object.create(null)
            for (const [branch, records] of Object.entries(pendingChanges)) {
                const group = snapshot[branch] = Object.create(null)
                for (const [id, record] of Object.entries(records))
                    group[id] = { ...record, paths: record.paths === null ? null : [...record.paths] }
            }
            for (const [id, { branch, record }] of Object.entries(inFlight)) {
                const group = snapshot[branch] ??= Object.create(null)
                const current = group[id]
                if (!current) group[id] = { ...record, paths: record.paths === null ? null : [...record.paths] }
                else current.paths = current.paths === null || record.paths === null
                    ? null : [...new Set([...record.paths, ...current.paths])]
            }
            return snapshot
        }
    })
    const groups = new Map()
    function primary(uuid) {
        let group = groups.get(uuid)
        if (!group) groups.set(uuid, group = { uuid, weight: 0, active: 0, members: new Set(), children: new Set() })
        return group
    }
    function track(leaf) {
        const group = primary(branchId(leaf))
        group.members.add(leaf.uuid)
        return group
    }
    function touch(leaf) {
        const group = track(leaf)
        group.weight++
        if (Object.hasOwn(db.config.leaves, leaf.uuid) && leaf.uuid !== group.uuid) primary(leaf.uuid).weight++
        let parent = db.config.leaves[group.uuid]?.parent
        while (parent) {
            const ancestor = groups.get(parent)
            if (ancestor) ancestor.weight++
            parent = db.config.leaves[parent]?.parent
        }
    }
    const deleted = db.deleted = new Map()
    db.deleting ??= new Set()
    let scheduled, indexError, closed = false
    let workQueue = Promise.resolve()
    let persistedConfig
    async function persistConfigIfChanged() {
        const current = JSON.stringify(db.config)
        if (current === persistedConfig) return
        await persistConfig()
        persistedConfig = JSON.stringify(db.config)
    }
    for (const route of db.config.indexes) {
        if (!route || typeof route.key !== 'string' || typeof route.type !== 'string' || typeof route.uuid !== 'string') throw Error('Invalid index root catalog')
        const tree = new IndexTree(size,db.local,route.key,leafSize,route.uuid)
        tree.route = route
        tree.primary = route.primary
        tree.valueType = route.type
        tree.resolveLeaf = async id => await db.leaves.get(id)
        let fields = db.tree.get(route.primary)
        if (!fields) db.tree.set(route.primary, fields = new Map())
        let types = fields.get(route.key)
        if (!types) fields.set(route.key, types = new Map())
        types.set(route.type,tree)
    }
    const insert = entry => insertEntry(db.tree, size, leafSize, entry, db.local, db.leaves, db.config.indexes)
    async function insertEntries(entries) {
        const batches = new Map()
        for (const entry of entries) {
            const index = indexTree(db.tree, size, leafSize, entry, db.local, db.leaves, db.config.indexes)
            let batch = batches.get(index)
            if (!batch) batches.set(index, batch = [])
            batch.push(entry)
        }
        for (const [index, batch] of batches) await index.insertMany(batch)
    }
    async function flushLeaf(leaf, changedPaths, insertBatch) {
        if(indexError)throw indexError
        try {
            if(deleted.get(leaf.uuid) === leaf) {
                if(db.deleting.has(leaf.uuid))return
                for(const entry of Object.values(await leaf.getIndex()))if(entry.tree)await removeIndexedEntry(entry)
            } else {
                await reconcileLeaf(leaf,entry=>{insertBatch.push(entry)},changedPaths instanceof Set?changedPaths:undefined)
            }
        }
        catch(error){indexError=error;throw error}
    }
    function serializeWork(operation) {
        const task = workQueue.then(operation, operation)
        workQueue = task.catch(() => {})
        return task
    }
    async function persistLeaves() {
        await db.leaves.persistDeletes?.()
        await db.leaves.persistDirty?.()
    }
    function enqueue(leaf, record, retry = false) {
        track(leaf)
        const branch = branchId(leaf)
        const group = pendingChanges[branch] ??= Object.create(null)
        const current = group[leaf.uuid]
        if (!current) {
            group[leaf.uuid] = record
            queuedCount++
            if (!Object.hasOwn(inFlight, leaf.uuid)) pendingCount++
        } else {
            if (!retry) current.operation = record.operation
            if (current.paths === null || record.paths === null) current.paths = null
            else for (const path of record.paths) if (!current.paths.includes(path)) current.paths.push(path)
        }
    }
    function queueIndex(leaf, changedPaths) {
        enqueue(leaf, {
            operation: deleted.get(leaf.uuid) === leaf ? 'delete' : 'write',
            paths: changedPaths === undefined ? null : [...changedPaths]
        })
        schedule()
    }
    const handler={queue:queueIndex}
    function emitPersistence(operation) {
        return persist?.(operation)
    }
    async function drain(limit = Infinity) {
        return await serializeWork(async () => {
        if (indexError) throw indexError
        // The response has already been acknowledged. Keep accepted leaves
        // durable before applying their derived index work.
        await persistLeaves()
        const batch=[]
        takeBatch:
        for (const branch in pendingChanges) {
            const group = pendingChanges[branch]
            for (const id in group) {
                if (batch.length >= limit) break takeBatch
                const record = group[id]
                delete group[id]
                queuedCount--
                inFlight[id] = { branch, record }
                // Queued leaves are pinned in memory until reconciliation ends.
                const leaf = deleted.get(id) ?? Map.prototype.get.call(db.leaves, id)
                if (!leaf) throw Error(`Queued leaf not found: ${id}`)
                batch.push({ leaf, record, changedPaths: record.paths === null ? undefined : new Set(record.paths) })
            }
            delete pendingChanges[branch]
        }
        if (!batch.length) return
        const leafChanges = batch.map(({ leaf }) => ({
            operation: deleted.get(leaf.uuid) === leaf ? 'delete' : 'write',
            kind: 'leaf',
            uuid: leaf.uuid
        }))
        // Keep queued leaves resident through reconciliation, then group the
        // resulting entries by index tree for insertion.
        const insertBatch=[]
        let indexed = false
        try {
            for (const {leaf,changedPaths} of batch) await flushLeaf(leaf,changedPaths,insertBatch)
            if (insertBatch.length) await insertEntries(insertBatch)
            syncIndexCatalog()
            const removedBranches = [...(db.local?.pendingDiscards ?? [])]
            const changedBranches = [...(db.local?.dirty ?? [])]
                .filter(branch => db.local.resident.has(branch))
                .map(branch => branch.uuid)
            await db.local?.persistDiscards()
            await db.local?.persistDirty()
            await persistConfigIfChanged()
            if (persist) await Promise.all([
                ...removedBranches.map(uuid => emitPersistence({ operation: 'delete', kind: 'branch', uuid })),
                ...changedBranches.map(uuid => emitPersistence({ operation: 'write', kind: 'branch', uuid })),
                ...leafChanges.map(emitPersistence)
            ])
            for (const {leaf} of batch) if (deleted.get(leaf.uuid) === leaf && !queued(leaf)) deleted.delete(leaf.uuid)
            indexed = true
        } catch (error) {
            for (const {leaf,record} of batch) enqueue(leaf, record, true)
            indexError = error
            throw error
        } finally {
            for (const {leaf} of batch) {
                delete inFlight[leaf.uuid]
                if (!queued(leaf)) pendingCount--
            }
        }
        if (indexed) await onIdle()
        })
    }
    function schedule() {
        if (closed || scheduled || !queuedCount || indexError) return
        scheduled = defer(async () => {
            scheduled = undefined
            try { await drain(INDEX_BATCH_SIZE) } catch { return }
            schedule()
        })
    }
    function syncIndexCatalog() {
        for (const fields of db.tree.values()) for (const types of fields.values())
            for (const tree of types.values()) if (tree.initialized) Object.assign(tree.route, {
                uuid: tree.root.uuid, count: tree.root.length, min: tree.root.firstValue, max: tree.root.lastValue
            })
    }

    function beginOperation(envelope, target) {
        const held = new Set()
        const active = {
            pin(uuid) {
                if (uuid !== undefined && !held.has(uuid)) { held.add(uuid); const group = primary(uuid); group.active++; group.weight++ }
            },
            async release() {
                for (const uuid of held) groups.get(uuid).active--
                held.clear()
                await onIdle()
            }
        }
        if (envelope && target) for (const path of rootPaths(db.config.roots, target)) {
            let parent
            for (const name of path.slice(0, -1)) {
                const ref = reference(envelope, name)
                if (!ref) break
                const uuid = ref.uuid ?? names.get(key(parent, name, ref.name))
                if (!uuid) break
                active.pin(uuid)
                parent = uuid
            }
        }
        return active
    }

    function subtree(uuid) {
        const ids = new Set([uuid])
        for (const id of ids) for (const child of groups.get(id)?.children ?? []) ids.add(child)
        return ids
    }
    function busyGroups() {
        const busy = new Set(Object.keys(pendingChanges))
        for (const { branch } of Object.values(inFlight)) busy.add(branch)
        return busy
    }
    function idle(ids, busy) {
        for (const uuid of ids)
            if (groups.get(uuid)?.active || busy.has(uuid) || pendingIndex.has({ uuid, parent: db.config.leaves[uuid]?.parent })) return false
        return true
    }
    // The queue remains the authority for both pending and in-flight work.
    function pruneCandidates() {
        if (!canPrune()) return []
        const busy = busyGroups()
        return [...groups.values()].filter(group => group.members.size && idle(subtree(group.uuid), busy))
    }
    function prunePrimary(uuid) {
        const group = groups.get(uuid)
        if (!canPrune() || !group?.members.size) return false
        const ids = subtree(uuid)
        if (!idle(ids, busyGroups())) return false
        for (const id of ids) {
            const fields = db.tree.get(id)
            if (!fields) continue
            for (const types of fields.values()) for (const index of types.values()) index.release()
            db.tree.delete(id)
        }
        for (const id of ids) {
            const group = groups.get(id)
            if (group) {
                for (const member of group.members) {
                    const leaf = Map.prototype.get.call(db.leaves, member)
                    if (leaf) db.leaves.releasePersisted(leaf)
                }
                group.members.clear()
            }
            const primary = Map.prototype.get.call(db.leaves, id)
            if (primary) db.leaves.releasePersisted(primary)
            groups.get(db.config.leaves[id]?.parent)?.members.delete(id)
        }
        return true
    }

    function primaryIndexes(primary, envelope = {}) {
        const allowed = new Map()
        const matches = uuid => {
            if (primary !== undefined) return uuid === primary
            if (allowed.has(uuid)) return allowed.get(uuid)
            let current = uuid, matches = true
            while (catalog[current]) {
                const node = catalog[current], ref = reference(envelope, node.root)
                if (ref && (ref.uuid ? ref.uuid !== current : ref.name !== node.name)) { matches = false; break }
                current = node.parent
            }
            allowed.set(uuid, matches)
            return matches
        }
        return db.config.indexes.filter(route => matches(route.primary)).map(route => {
            const index = db.tree.get(route.primary)?.get(route.key)?.get(route.type)
            const root = index?.initialized ? index.root : undefined
            return {
                ...route,
                count: root?.length ?? route.count,
                min: root ? root.firstValue : route.min,
                max: root ? root.lastValue : route.max,
                branches: root?.branches?.map(branch => index.reference(branch)) ?? []
            }
        })
    }

    function readIndex(primary, key, valueType) {
        let fields = db.tree.get(primary)
        let types = fields?.get(key)
        let index = types?.get(valueType)
        if (index) return index
        const route = db.config.indexes.find(route => route.primary === primary && route.key === key && route.type === valueType)
        if (!route) return undefined
        if (!fields) db.tree.set(primary, fields = new Map())
        if (!types) fields.set(key, types = new Map())
        index = new IndexTree(size, db.local, key, leafSize, route.uuid)
        Object.assign(index, { route, primary, valueType, resolveLeaf: getLeaf })
        types.set(valueType, index)
        return index
    }

    async function restoreIndexes(leaf, keys) {
        const values = keys === undefined ? indexValues(leaf) : undefined
        for (const key of keys ?? values.keys()) {
            if (key === 'uuid' || hasIndexEntry(leaf, key)) continue
            const value = values ? values.get(key) : getValueFromObject(leaf, key)
            const index = readIndex(branchId(leaf), key, type(value))
            if (!index) continue
            const entry = await index.lookup(value, leaf.uuid)
            if (entry) attachIndexEntry(leaf, entry)
        }
    }

    async function close() {
        closed = true
        if (scheduled) cancelDefer(scheduled)
        scheduled = undefined
        do { await drain() } while (pendingCount)
        await persistLeaves()
        await db.local?.persistDiscards()
        await db.local?.persistDirty()
        syncIndexCatalog()
        await persistConfigIfChanged()
    }

    async function visitRange(key, valueType, { min, max, branchUuid, mutating = false } = {}, visit) {
        return await visitRanges(key, valueType, [{ min, max, branchUuid }], { mutating }, visit)
    }

    async function visitRanges(key, valueType, ranges, { mutating = false } = {}, visit) {
        if (typeof visit !== 'function') throw new TypeError('visit must be a function')
        const index = [...db.tree.values()].map(fields => fields.get(key)?.get(valueType)).find(Boolean)
        if (!index || !ranges?.length) return 0
        let count = 0
        for (const range of ranges) {
            const branch = range.branchUuid ? await index.findUuid(range.branchUuid) : index.root
            if (!branch) continue
            for await (const entry of index.scan(range.min, range.max, branch)) {
                const leaf = await getLeaf(entry.uuid)
                if (!leaf || deleted.has(entry.uuid)) continue
                count++
                if (await visit(leaf, entry) === STOP) return count
            }
        }
        return count
    }

    async function visitLeaves({ mutating = false } = {}, visit) {
        if (typeof visit !== 'function') throw new TypeError('visit must be a function')
        let count = 0
        for await (const leaf of db.leaves.values()) {
            if (!leaf || deleted.has(leaf.uuid)) continue
            count++
            if (await visit(leaf) === STOP) break
        }
        return count
    }


    const names = new Map()
    const identities = new Map()
    const identityKey = (parent, id) => JSON.stringify([parent, id])
    const key = (parent, root, name) => JSON.stringify([parent, root, name])
    const catalog = db.config.leaves
    const dynamicKeys = new Set()
    function refreshDynamicKeys() {
        dynamicKeys.clear()
        function visit(node) {
            for (const [root, child] of Object.entries(node)) {
                if (root.startsWith('$')) dynamicKeys.add(root.slice(1))
                visit(child)
            }
        }
        visit(db.config.roots)
    }
    async function structural(parent, root) {
        let node = db.config.roots
        const path = []
        while (parent) { path.push(parent.root); parent = catalog[parent.parent] ?? await getLeaf(parent.parent) }
        for (let i = path.length - 1; i >= 0; i--) node = node?.[path[i]]
        return Object.keys(node?.[root] ?? {}).length > 0
    }
    function register(leaf) {
        const { uuid, root, parent, name } = leaf
        const k = key(parent, root, name)
        if (names.has(k) && names.get(k) !== uuid) throw Error('duplicate root name')
        names.set(k, uuid)
        primary(uuid)
        if (parent) primary(parent).children.add(uuid)
        Object.defineProperty(catalog, uuid, { value: { root, ...(parent === undefined ? {} : { parent }), name }, enumerable: true, writable: true, configurable: true })
        // A CRUD request persists the complete config with its local write.
    }
    function find(parent, root, ref, operation) {
        if (!ref) return []
        const uuid = ref.uuid ?? names.get(key(parent?.uuid, root, ref.name))
        const node = catalog[uuid]
        if (!node || node.root !== root || node.parent !== parent?.uuid) return []
        operation?.pin(uuid)
        return [{ uuid, ...node }]
    }
    function configuration(writable = true) {
        const snapshot = structuredClone(db.config)
        Object.defineProperties(snapshot, {
            getValue: { value: path => structuredClone(getValueFromObject(db.config, path)) },
            setValue: { value: async (path, value) => {
                if (!writable) throw Error('Configuration updates require the primary')
                if (typeof path !== 'string' || !/^roots(?:\.[^.[\]]+)*$/.test(path) || path.split('.').some(k => ['__proto__','constructor','prototype'].includes(k))) throw Error('Only root definitions can be edited directly')
                const next = structuredClone(db.config)
                if (dotNotationToObject({ [path]: structuredClone(value) }, next) === false) throw Error('Invalid configuration update')
                rootPaths(next.roots, '')
                for await (const leaf of db.leaves.values()) {
                    let node = next.roots
                    const path = [leaf.root]
                    let parent = await getLeaf(leaf.parent)
                    while (parent) { path.unshift(parent.root); parent = catalog[parent.parent] ?? await getLeaf(parent.parent) }
                    for (const part of path) node = node?.[part]
                    if (!isRecord(node)) throw Error('Cannot remove an occupied root')
                    if (Boolean(Object.keys(node).length) !== Object.hasOwn(catalog, leaf.uuid)) throw Error('Cannot change structural status of an occupied root')
                }
                db.config.roots = next.roots
                refreshDynamicKeys()
                await persistConfigIfChanged()
                return configuration()
            } }
        })
        return snapshot
    }
    function getRoots(path) {
        return structuredClone(path ? getValueFromObject(db.config.roots, path) : db.config.roots)
    }
    async function setRoots(path, value) {
        if (path !== undefined && typeof path !== 'string') throw new TypeError('Root path must be a string')
        const configPath = path ? `roots.${path}` : 'roots'
        await configuration().setValue(configPath, value)
        return getRoots(path)
    }
    async function create(value, parent, root, { identityChecked = false, structural: structuralValue } = {}) {
        if (!isRecord(value)) throw new TypeError(`${root} must contain an object`)
        const suppliedUuid = value.uuid !== undefined
        value.root = root
        if (parent) value.parent = parent.uuid
        else delete value.parent
        value.uuid ??= uuidValue()
        const isRoot = structuralValue ?? await structural(parent, root)
        if (isRoot && (typeof value.name !== 'string' || !value.name || names.has(key(parent?.uuid, root, value.name)))) throw Error('Invalid or duplicate root name')
        if (root === 'object') value._id ??= uuidValue().slice(0, 24)
        if (root === "object" && identities.has(identityKey(value.parent, value._id))) throw Error("duplicate identity")
        if (deleted.has(value.uuid) || suppliedUuid && !identityChecked && await db.leaves.has(value.uuid)) throw new Error(`Leaf UUID already exists: ${value.uuid}`)
        const leaf = createLeaf(value, isRoot)
        db.leaves.set(leaf.uuid, leaf)
        touch(leaf)
        db.leaves.markDirty?.(leaf)
        deferLeaf(leaf,handler)
        queueIndex(leaf)
        if (root === "object") identities.set(identityKey(leaf.parent, leaf._id), leaf.uuid)
        if (isRoot) register(leaf)
        bindLeaf(leaf)
        return leaf
    }
    function bindLeaf(leaf) {
        deferLeaf(leaf,handler)
        Object.defineProperty(leaf, Symbol.for("cocreate.deleteLeaf"), {value:()=>remove(leaf)})
        Object.defineProperty(leaf, Symbol.for("cocreate.isLiveLeaf"), {value:async()=>await getLeaf(leaf.uuid)===leaf})
        Object.defineProperty(leaf, Symbol.for("cocreate.markDirty"), {value:async()=>{db.leaves.markDirty?.(leaf)}})
        return leaf
    }
    function restoreLeaf(value){
        const structuralLeaf=Object.hasOwn(catalog,value.uuid)
        const leaf=createLeaf(value,structuralLeaf)
        db.leaves.set(leaf.uuid,leaf)
        track(leaf)
        if(leaf.root==='object')identities.set(identityKey(leaf.parent,leaf._id),leaf.uuid)
        if(structuralLeaf)register(leaf)
        bindIndexRestore(leaf, keys => restoreIndexes(leaf, keys))
        initializeLeaf(leaf, insert)
        return bindLeaf(leaf)
    }
    if (db.leaves) db.leaves.restore = data => restoreLeaf(data.object)

    const remoteReads = new Map()
    async function getLeaf(id, operation) {
        if (typeof id !== 'string' || !id) return undefined
        const resident = Map.prototype.get.call(db.leaves, id)
        if (resident) operation?.pin(branchId(resident))
        const local = await db.leaves.get(id, operation)
        if (local) { touch(local); return local }
        if (typeof db.readExternal !== 'function') return undefined
        if (remoteReads.has(id)) return await remoteReads.get(id)
        const task = (async () => {
            const existing = await db.leaves.get(id)
            if (existing) return existing
            const value = await db.readExternal(id)
            if (!value) return undefined
            if (value.uuid !== id) throw new Error(`Persistence returned a mismatched leaf UUID: ${id}`)
            operation?.pin(branchId(value))
            const restored = await restoreLeaf(structuredClone(value))
            db.leaves.markDirty?.(restored)
            const cache = beginOperation()
            cache.pin(branchId(restored))
            serializeWork(async () => {
                try { await persistLeaves() } finally { await cache.release() }
            }).catch(error => { indexError = error })
            return restored
        })()
        remoteReads.set(id, task)
        try { return await task }
        finally { remoteReads.delete(id) }
    }
    async function hasLeaf(id) {
        if (typeof id !== 'string' || !id) return false
        if (await db.leaves.has(id)) return true
        if (typeof db.readExternal !== 'function') return false
        const value = await db.readExternal(id)
        if (!value) return false
        if (value.uuid !== id) throw new Error(`Persistence returned a mismatched leaf UUID: ${id}`)
        return true
    }
    db.getLeaf = getLeaf
    db.readIndex = readIndex
    db.operation = beginOperation
    db.pendingIndex = pendingIndex

    async function remove(leaf) {
        if(await getLeaf(leaf.uuid)!==leaf)throw Error('Leaf not found')
        if (Object.hasOwn(catalog, leaf.uuid) && Object.values(catalog).some(child => child.parent === leaf.uuid)) throw Error('Cannot delete a root that still has child leaves')
        const id=leaf.uuid
        db.deleting.add(id)
        deleted.set(id,leaf)
        await db.leaves.delete(id)
        db.deleting.delete(id)
        if (leaf.root === 'object') identities.delete(identityKey(leaf.parent, leaf._id))
        if (Object.hasOwn(catalog, id)) {
            names.delete(key(leaf.parent, leaf.root, leaf.name))
            groups.get(leaf.parent)?.children.delete(leaf.uuid)
            groups.get(leaf.uuid)?.members.clear()
            delete catalog[id]
            await persistConfigIfChanged()
        }
        queueIndex(leaf)
        return true
    }

    function validateTarget(target) {
        const paths = rootPaths(db.config.roots, target)
        if (!paths.length) throw new Error(`Root is not configured: ${target}`)
        return paths
    }

    async function resolve(envelope, target, { createMissing = false, operation } = {}) {
        const paths = validateTarget(target)
        const eligible = paths.filter(path => path.slice(0, -1).every(name => reference(envelope, name)))
        if (!eligible.length) {
            const name = paths[0].slice(0, -1).find(part => !reference(envelope, part))
            throw new Error(`Missing root reference${name ? `: ${name}` : ''}`)
        }
        if (eligible.length > 1) throw new Error(`Ambiguous root path for ${target}`)
        const path = eligible[0], created = []
        let parent
        for (const name of path.slice(0, -1)) {
            const ref = reference(envelope, name)
            const matches = find(parent, name, ref, operation)
            if (matches.length > 1) throw new Error(`Ambiguous ${name} root reference`)
            let leaf = matches[0]
            if (!leaf) {
                if (!createMissing) return { target, parent, created, missing: true, path }
                if (ref.uuid) throw new Error(`Root leaf not found: ${name}`)
                leaf = await create({ name: ref.name }, parent, name)
                created.push(leaf)
            }
            parent = leaf
        }
        return { target, parent, created, missing: false, path }
    }

    async function createMany(values, parent, root, { identityChecked = false } = {}) {
        const structuralValue = await structural(parent, root)
        const leaves = []
        try {
            for (const value of values) {
                const leaf = await create(value, parent, root, { identityChecked, structural: structuralValue })
                if (leaf) leaves.push(leaf)
            }
        } catch (error) {
            throw error
        }
        if (leaves.length) schedule()
        return leaves
    }

    async function matchesRoot(envelope, target, leaf, operation) {
        if (!leaf || leaf.root !== target) return false
        const seen = new Set([leaf.uuid])
        let current = leaf
        while (current.parent !== undefined) {
            if (seen.has(current.parent)) throw Error('Cyclic leaf ancestry')
            seen.add(current.parent)
            const uuid = current.parent
            current = catalog[uuid] ?? await getLeaf(uuid, operation)
            if (!current) return false
            const ref = reference(envelope, current.root)
            if (ref && (ref.uuid ? ref.uuid !== uuid : ref.name !== current.name)) return false
        }
        return true
    }

    rootPaths(db.config.roots, '')
    refreshDynamicKeys()
    if (!isRecord(catalog)) throw Error('Invalid root catalog')
    const pending = new Map(Object.entries(catalog))
    while (pending.size) {
        const count = pending.size
        for (const [id, value] of pending) {
            if (!isRecord(value) || typeof value.root !== 'string') throw Error('Invalid configured root identity')
            const parent = await getLeaf(value.parent)
            if (value.parent !== undefined && !parent) continue
            if (!await structural(parent, value.root)) throw Error('Invalid configured root identity')
            let node = db.config.roots
            const path = [value.root]
            let ancestor = parent
            while (ancestor) { path.unshift(ancestor.root); ancestor = await getLeaf(ancestor.parent) }
            for (const part of path) node = node?.[part]
            if (!isRecord(node)) throw Error('Invalid configured root path')
            const leaf = await getLeaf(id)
            if (leaf) {
                if (leaf.root !== value.root || leaf.parent !== value.parent || leaf.name !== value.name) throw Error('Configured root leaf does not match its catalog')
                if (!names.has(key(value.parent, value.root, value.name))) register(leaf)
            } else await create({ uuid: id, name: value.name }, parent, value.root)
            pending.delete(id)
        }
        if (pending.size === count) throw Error('Missing or cyclic configured parent')
    }
    persistedConfig = JSON.stringify(db.config)
    return { create, createMany, getLeaf, hasLeaf, setReadExternal: read => { db.readExternal = read }, resolve, matchesRoot, visitRange, visitRanges, visitLeaves, getLeaves: getLeaves.bind(db), remove, validateTarget, configuration, getRoots, setRoots, restoreLeaf, close, pendingIndex, operation: beginOperation, readIndex, pruneCandidates, prunePrimary, primaryIndexes, groups, hasIdentity: (parent,id) => identities.has(identityKey(parent?.uuid,id)) }
}
