import { uuid, getValueFromObject } from '@cocreate/utils'
import { defer, cancelDefer } from './defer.js'
import { createLeaf, initializeLeaf, bindIndexRestore, hasIndexEntry, attachIndexEntry, indexValues, type, deferLeaf, reconcileLeaf, removeIndexedEntry } from './leaf.js'
import getLeaves from './query.js'
import { Tree as IndexTree } from './btree.js'
import { DiskQueue } from './disk.js'

const uuidValue = () => uuid().replaceAll('-', '')
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const STOP = Symbol.for('cocreate.db.tree.stop')
const INDEX_BATCH_SIZE = 1024

function indexTree(tree, size, leafSize, entry, local, leaves, catalog) {
    const fields = tree
    let types = fields.get(entry.key)
    if (!types) fields.set(entry.key, types = new Map())
    let index = types.get(type(entry.value))
    if (!index) {
        const route = catalog.find(route => route.key === entry.key && route.type === type(entry.value))
        types.set(type(entry.value), index = new IndexTree(size,local,entry.key,leafSize,route?.uuid))
        index.route = route ?? { key: entry.key, type: type(entry.value), uuid: index.root.uuid }
        if (!route) catalog.push(index.route)
        index.valueType = type(entry.value)
        index.resolveLeaf = async id => await leaves.get(id)
    }
    return index
}

async function insertEntry(tree, size, leafSize, entry, local, leaves, catalog) {
    const index = indexTree(tree, size, leafSize, entry, local, leaves, catalog)
    await entry.insert(index)
}

export async function createManager({ db, owner, size = 1024, leafSize = size, write = () => {}, persist = () => {}, onIdle = () => {} }) {
    const pendingChanges = Object.create(null)
    const inFlight = Object.create(null)
    let queuedCount = 0
    let pendingCount = 0
    const queued = leaf => pendingChanges[leaf.uuid]
    const pendingIndex = Object.freeze({
        get size() { return pendingCount },
        has(leaf) { return !!queued(leaf) || Object.hasOwn(inFlight, leaf.uuid) },
        toJSON() {
            const snapshot = Object.create(null)
            for (const [id, record] of Object.entries(inFlight)) snapshot[id] = { ...record, paths: record.paths === null ? null : [...record.paths] }
            for (const [id, record] of Object.entries(pendingChanges)) {
                const previous = snapshot[id]
                snapshot[id] = { ...record, paths: record.paths === null || previous?.paths === null
                    ? null : [...new Set([...(previous?.paths ?? []), ...record.paths])] }
            }
            return snapshot
        }
    })
    const deleted = db.deleted = new Map()
    let scheduled, indexError, closed = false
    let indexWork = Promise.resolve()
    let queuedConfig
    function configurationFile() {
        const data = JSON.stringify(db.config)
        if (data === queuedConfig) return undefined
        queuedConfig = data
        return data
    }
    function releaseDeleted(uuid) {
        if (!pendingIndex.has({ uuid }) && !disk.hasLeaf(uuid)) deleted.delete(uuid)
    }
    const disk = new DiskQueue(owner.uuid, write, persist, batch => {
        for (const [uuid, record] of Object.entries(batch.leaves)) if (record.operation === 'delete') releaseDeleted(uuid)
    }, onIdle)
    db.diskQueue = disk
    for (const route of db.config.indexes) {
        if (!route || typeof route.key !== 'string' || typeof route.type !== 'string' || typeof route.uuid !== 'string') throw Error('Invalid index root catalog')
        const tree = new IndexTree(size,db.local,route.key,leafSize,route.uuid)
        tree.route = route
        tree.valueType = route.type
        tree.resolveLeaf = async id => await db.leaves.get(id)
        const fields = db.tree
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
        if (deleted.get(leaf.uuid) === leaf) {
            for (const entry of Object.values(await leaf.getIndex())) if (entry.tree) await removeIndexedEntry(entry)
        } else {
            await reconcileLeaf(leaf, entry => { insertBatch.push(entry) }, changedPaths instanceof Set ? changedPaths : undefined)
        }
    }
    function serializeIndex(operation) {
        const task = indexWork.then(operation, operation)
        indexWork = task.catch(() => {})
        return task
    }
    function enqueue(leaf, record, retry = false) {
        const current = pendingChanges[leaf.uuid]
        if (!current) {
            pendingChanges[leaf.uuid] = record
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
    async function drain(limit = Infinity) {
        return await serializeIndex(async () => {
        if (indexError) throw indexError
        const batch=[]
        for (const id in pendingChanges) {
            if (batch.length >= limit) break
            const record = pendingChanges[id]
            delete pendingChanges[id]
            queuedCount--
            inFlight[id] = record
            const leaf = deleted.get(id) ?? Map.prototype.get.call(db.leaves, id)
            if (!leaf) throw Error(`Queued leaf not found: ${id}`)
            batch.push({ leaf, record, changedPaths: record.paths === null ? undefined : new Set(record.paths) })
        }
        if (!batch.length) return
        // Keep queued leaves resident through reconciliation, then group the
        // resulting entries by index tree for insertion.
        const insertBatch=[]
        let indexed = false
        try {
            for (const {leaf,changedPaths} of batch) await flushLeaf(leaf,changedPaths,insertBatch)
            if (insertBatch.length) await insertEntries(insertBatch)
            syncIndexCatalog()
            const leaves = Object.create(null)
            for (const { leaf } of batch) leaves[leaf.uuid] = deleted.get(leaf.uuid) === leaf
                ? { operation: 'delete' }
                : { operation: 'write', data: JSON.stringify({ object: leaf }) }
            disk.enqueue({ leaves, branches: db.local?.takeChanges(), config: configurationFile() })
            indexed = true
        } catch (error) {
            for (const {leaf,record} of batch) enqueue(leaf, record, true)
            indexError = error
            throw error
        } finally {
            for (const {leaf} of batch) {
                delete inFlight[leaf.uuid]
                if (!queued(leaf)) pendingCount--
                releaseDeleted(leaf.uuid)
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
        for (const types of db.tree.values())
            for (const tree of types.values()) if (tree.initialized) Object.assign(tree.route, {
                uuid: tree.root.uuid, count: tree.root.length, min: tree.root.firstValue, max: tree.root.lastValue
            })
    }

    function beginOperation() {
        owner.active++
        owner.weight++
        let released = false
        return { async release() {
            if (released) return
            released = true
            owner.active--
            await onIdle()
        } }
    }

    function primaryIndexes() {
        return db.config.indexes.map(route => {
            const index = db.tree.get(route.key)?.get(route.type)
            const root = index?.initialized ? index.root : undefined
            return { ...route, primary: owner.uuid,
                count: root?.length ?? route.count,
                min: root ? root.firstValue : route.min,
                max: root ? root.lastValue : route.max,
                branches: root?.branches?.map(branch => index.reference(branch)) ?? [] }
        })
    }

    function readIndex(key, valueType) { return db.tree.get(key)?.get(valueType) }

    async function restoreIndexes(leaf, keys) {
        const values = keys === undefined ? indexValues(leaf) : undefined
        for (const key of keys ?? values.keys()) {
            if (key === 'uuid' || hasIndexEntry(leaf, key)) continue
            const value = values ? values.get(key) : getValueFromObject(leaf, key)
            const index = readIndex(key, type(value))
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
        syncIndexCatalog()
        const branches = db.local?.takeChanges()
        const config = configurationFile()
        if (config !== undefined || branches && Object.keys(branches).length) disk.enqueue({ branches, config })
        await disk.close()
    }

    async function visitRange(key, valueType, { min, max, branchUuid, mutating = false } = {}, visit) {
        return await visitRanges(key, valueType, [{ min, max, branchUuid }], visit)
    }

    async function visitRanges(key, valueType, ranges, visit) {
        if (typeof visit !== 'function') throw new TypeError('visit must be a function')
        const index = db.tree.get(key)?.get(valueType)
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

    async function visitLeaves(visit) {
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
    const storedIdentities = db.config.indexes.some(index => index.key === '_id')
    const structural = root => Object.keys(db.config.roots[root] ?? {}).length > 0
    const belongs = value => value.parent === db.config.parent && Object.hasOwn(db.config.roots, value.root)
    async function create(root, value, { identityChecked = false } = {}) {
        if (!isRecord(value)) throw new TypeError(`${root} must contain an object`)
        const suppliedUuid = value.uuid !== undefined
        value.root = root
        if (db.config.parent !== undefined) value.parent = db.config.parent
        else delete value.parent
        value.uuid ??= uuidValue()
        const isRoot = structural(root)
        if (isRoot && (typeof value.name !== 'string' || !value.name || names.has(JSON.stringify([root, value.name])))) throw Error('Invalid or duplicate root name')
        if (root === 'object' && value._id !== undefined && storedIdentities) {
            const index = readIndex('_id', type(value._id))
            if (index) for await (const entry of index.scan(value._id, value._id))
                if (!deleted.has(entry.uuid)) throw new Error('duplicate identity')
        }
        if (root === 'object') value._id ??= uuidValue().slice(0, 24)
        if (root === "object" && identities.has(value._id)) throw Error("duplicate identity")
        if (deleted.has(value.uuid) || suppliedUuid && !identityChecked && await db.leaves.has(value.uuid)) throw new Error(`Leaf UUID already exists: ${value.uuid}`)
        const leaf = createLeaf(value, isRoot)
        db.leaves.set(leaf.uuid, leaf)
        deferLeaf(leaf,handler)
        queueIndex(leaf)
        if (root === "object") identities.set(leaf._id, leaf.uuid)
        if (isRoot) names.set(JSON.stringify([root, leaf.name]), leaf.uuid)
        bindLeaf(leaf)
        return leaf
    }
    function bindLeaf(leaf) {
        deferLeaf(leaf,handler)
        Object.defineProperty(leaf, Symbol.for("cocreate.deleteLeaf"), {value:()=>remove(leaf)})
        Object.defineProperty(leaf, Symbol.for("cocreate.isLiveLeaf"), {value:async()=>await getLeaf(leaf.uuid)===leaf})

        return leaf
    }
    function restoreLeaf(value){
        if (!belongs(value)) return undefined
        const structuralLeaf=structural(value.root)
        const leaf=createLeaf(value,structuralLeaf)
        db.leaves.set(leaf.uuid,leaf)
        if(leaf.root==='object')identities.set(leaf._id,leaf.uuid)
        if(structuralLeaf)names.set(JSON.stringify([leaf.root,leaf.name]),leaf.uuid)
        bindIndexRestore(leaf, keys => restoreIndexes(leaf, keys))
        initializeLeaf(leaf, insert)
        return bindLeaf(leaf)
    }
    if (db.leaves) { db.leaves.restore = data => restoreLeaf(data.object); db.leaves.belongs = belongs; db.leaves.deleted = deleted }

    const remoteReads = new Map()
    async function getLeaf(id, operation) {
        if (typeof id !== 'string' || !id || deleted.has(id)) return undefined
        const local = await db.leaves.get(id, operation)
        if (local) return local
        if (typeof db.readExternal !== 'function') return undefined
        if (remoteReads.has(id)) return await remoteReads.get(id)
        const task = (async () => {
            const existing = await db.leaves.get(id)
            if (existing) return existing
            const value = await db.readExternal(id)
            if (!value) return undefined
            if (value.uuid !== id) throw new Error(`Persistence returned a mismatched leaf UUID: ${id}`)
            if (!belongs(value)) return undefined
            const restored = await restoreLeaf(structuredClone(value))
            if (db.local) disk.enqueue({ leaves: { [id]: { operation: 'write', data: JSON.stringify({ object: restored }), notify: false } } })
            return restored
        })()
        remoteReads.set(id, task)
        try { return await task }
        finally { remoteReads.delete(id) }
    }
    async function hasLeaf(id) {
        if (typeof id !== 'string' || !id || deleted.has(id)) return false
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
        const id=leaf.uuid
        deleted.set(id,leaf)
        db.leaves.delete(id)
        if (leaf.root === 'object') identities.delete(leaf._id)
        if (structural(leaf.root)) names.delete(JSON.stringify([leaf.root, leaf.name]))
        queueIndex(leaf)
        return true
    }

    async function createMany(root, values, options) {
        if (!Object.hasOwn(db.config.roots, root)) throw new Error(`Root is not configured: ${root}`)
        const leaves = []
        for (const value of values) leaves.push(await create(root, value, options))
        return leaves
    }
    queuedConfig = JSON.stringify(db.config)
    return { create, createMany, getLeaf, hasLeaf, setReadExternal: read => { db.readExternal = read },
        matchesRoot: (envelope, target, leaf) => belongs(leaf) && leaf.root === target,
        visitRange, visitRanges, visitLeaves, getLeaves: getLeaves.bind(db), remove,
        async hasRoot(root) {
            for (const leaf of Map.prototype.values.call(db.leaves)) if (leaf.root === root) return true
            const index = readIndex('root', 'string')
            if (index) for await (const entry of index.scan(root, root)) if (!deleted.has(entry.uuid)) return true
            return false
        },
        async configureRoots(roots) {
            const activity = beginOperation()
            try {
                db.config.roots = structuredClone(roots)
                const config = configurationFile()
                if (config !== undefined) disk.enqueue({ config })
            } finally { await activity.release() }
        },
        restoreLeaf, close, pendingIndex, disk, operation: beginOperation, readIndex, primaryIndexes }
}
