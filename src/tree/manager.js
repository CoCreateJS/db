import { uuid, getValueFromObject, dotNotationToObject } from '@cocreate/utils'
import { defer, cancelDefer } from './defer.js'
import { createLeaf, attach, initializeLeaf, type, deferLeaf, reconcileLeaf } from './leaf.js'
import { Tree as IndexTree } from './btree.js'

const uuidValue = () => uuid().replaceAll('-', '')
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const STOP = Symbol.for('cocreate.db.tree.stop')

export function defaultConfiguration() {
    return {
        version: '1.0.0',
        roots: {
            $organization_id: { storage: { database: { array: { object: {}, index: {} } } } }
        },
        indexes: []
    }
}

export function createConfiguration({ config, roots, version } = {}) {
    const defaults = defaultConfiguration()
    const source = config && isRecord(config) ? config : {}
    const activeRoots = roots ?? source.roots ?? defaults.roots
    if (!isRecord(activeRoots)) throw new TypeError('roots must be an ordinary object')
    return { version: version ?? source.version ?? defaults.version, roots: structuredClone(activeRoots), leaves: structuredClone(source.leaves ?? {}), indexes: structuredClone(source.indexes ?? []) }
}

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

async function insertEntry(tree, size, leafSize, entry, local, leaves) {
    let types = tree.get(entry.key)
    if (!types) tree.set(entry.key, types = new Map())
    let index = types.get(type(entry.value))
    if (!index) {
        types.set(type(entry.value), index = new IndexTree(size,local,entry.key,leafSize))
        index.resolveLeaf = async id => await leaves.get(id)
    }
    await entry.insert(index)
}

export async function createRootManager({ db, size = 1024, leafSize = size, deferIndex = false, persistConfig = () => {}, persist = async () => ({ success: true }) }) {
    const pendingIndex = new Set()
    const deleted = db.deleted = new Map()
    db.deleting ??= new Set()
    let scheduled, indexError, activeTraversals = 0
    let workQueue = Promise.resolve()
    for (const route of db.config.indexes) {
        if (!route || typeof route.key !== 'string' || typeof route.type !== 'string' || typeof route.uuid !== 'string') throw Error('Invalid index root catalog')
        const tree = new IndexTree(size,db.local,route.key,leafSize,route.uuid)
        let types = db.tree.get(route.key)
        if (!types) db.tree.set(route.key,types = new Map())
        types.set(route.type,tree)
    }
    const insert = entry => insertEntry(db.tree, size, leafSize, entry, db.local, db.leaves)
    async function flushLeaf(leaf) {
        if(indexError)throw indexError
        if(!pendingIndex.has(leaf))return
        try {
            if(deleted.get(leaf.uuid) === leaf) {
                if(db.deleting.has(leaf.uuid))return
                for(const entry of Object.values(await leaf.getIndex()))if(entry.index)await entry.tree.remove(entry)
                deleted.delete(leaf.uuid)
            } else await reconcileLeaf(leaf,insert)
            pendingIndex.delete(leaf)
        }
        catch(error){indexError=error;throw error}
    }
    async function persistLeaves() {
        await db.leaves.persistDeletes?.()
        await db.leaves.persistDirty?.()
    }
    function serializeWork(operation) {
        const task = workQueue.then(operation, operation)
        workQueue = task.catch(() => {})
        return task
    }
    const handler={queue(leaf){pendingIndex.add(leaf);schedule()},flush:leaf=>serializeWork(async()=>{await persistLeaves();return await flushLeaf(leaf)})}
    async function stagePersistence(leaf, op = 'upsert') {
        const root = rootIds.get(leaf.uuid) ?? rootIds.get(leaf.parent) ?? leaf.parent ?? leaf.uuid
        return await persist({ method: 'persistence.stage', persistence: { root, uuid: leaf.uuid, op } })
    }
    async function drain(limit = Infinity) {
        return await serializeWork(async () => {
        if (indexError) throw indexError
        // Leaves are the recovery source: make pending leaf writes durable
        // before constructing or changing any derived index entries.
        await persistLeaves()
        for (const leaf of pendingIndex) {
            if (limit-- <= 0) break
            try { await flushLeaf(leaf) }
            catch (error) { indexError = error; throw error }
        }
        })
    }
    function schedule() {
        if (scheduled || !pendingIndex.size || indexError || activeTraversals) return
        scheduled = defer(async () => {
            scheduled = undefined
            try { await drain(64) } catch { return }
            schedule()
        })
    }
    async function flushIndex() {
        if (scheduled) cancelDefer(scheduled)
        scheduled = undefined
        await drain()
    }

    function syncIndexCatalog() {
        db.config.indexes = []
        for (const [key,types] of db.tree) for (const [valueType,tree] of types)
            db.config.indexes.push({key,type:valueType,uuid:tree.root.uuid})
    }

    async function visitRange(key, valueType, { min, max, branchUuid, mutating = false } = {}, visit) {
        return await visitRanges(key, valueType, [{ min, max, branchUuid }], { mutating }, visit)
    }

    async function visitRanges(key, valueType, ranges, { mutating = false } = {}, visit) {
        if (typeof visit !== 'function') throw new TypeError('visit must be a function')
        await flushIndex()
        const index = db.tree.get(key)?.get(valueType)
        if (!index || !ranges?.length) return 0
        activeTraversals++
        let count = 0
        try {
            for (const range of ranges) {
                const branch = range.branchUuid ? await index.findUuid(range.branchUuid) : index.root
                if (!branch) continue
                for await (const entry of index.scan(range.min, range.max, branch)) {
                    const leaf = await getLeaf(entry.uuid)
                    if (!leaf || deleted.has(entry.uuid)) continue
                    const restoreDefer = mutating ? deferLeaf(leaf, handler) : undefined
                    try {
                        count++
                        if (await visit(leaf, entry) === STOP) return count
                    } finally { restoreDefer?.() }
                }
            }
        } finally {
            activeTraversals--
            if (!activeTraversals) {
                if (deferIndex) schedule()
                else await drain()
            }
        }
        return count
    }

    async function visitLeaves({ mutating = false } = {}, visit) {
        if (typeof visit !== 'function') throw new TypeError('visit must be a function')
        await flushIndex()
        activeTraversals++
        let count = 0
        try {
            for await (const leaf of db.leaves.values()) {
                if (!leaf || deleted.has(leaf.uuid)) continue
                const restoreDefer = mutating ? deferLeaf(leaf, handler) : undefined
                try {
                    count++
                    if (await visit(leaf) === STOP) break
                } finally { restoreDefer?.() }
            }
        } finally {
            activeTraversals--
            if (!activeTraversals) {
                if (deferIndex) schedule()
                else await drain()
            }
        }
        return count
    }

    const names = new Map()
    const identities = new Map()
    const rootIds = new Map()
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
        while (parent) { path.push(parent.root); parent = await getLeaf(parent.parent) }
        for (let i = path.length - 1; i >= 0; i--) node = node?.[path[i]]
        return Object.keys(node?.[root] ?? {}).length > 0
    }
    function register(leaf) {
        const { uuid, root, parent, name } = leaf
        const k = key(parent, root, name)
        if (names.has(k) && names.get(k).uuid !== uuid) throw Error('duplicate root name')
        names.set(k, leaf)
        Object.defineProperty(catalog, uuid, { value: { root, ...(parent === undefined ? {} : { parent }), name }, enumerable: true, writable: true, configurable: true })
        // A CRUD request persists the complete config with its local write.
    }
    async function find(parent, root, ref) {
        if (!ref) return []
        const leaf = ref.uuid ? await getLeaf(ref.uuid) : names.get(key(parent?.uuid, root, ref.name))
        return leaf && await getLeaf(leaf.uuid)===leaf && leaf.root === root && leaf.parent === parent?.uuid ? [leaf] : []
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
                    while (parent) { path.unshift(parent.root); parent = await getLeaf(parent.parent) }
                    for (const part of path) node = node?.[part]
                    if (!isRecord(node)) throw Error('Cannot remove an occupied root')
                    if (Boolean(Object.keys(node).length) !== Object.hasOwn(catalog, leaf.uuid)) throw Error('Cannot change structural status of an occupied root')
                }
                db.config.roots = next.roots
                refreshDynamicKeys()
                await persistConfig()
                return configuration()
            } }
        })
        return snapshot
    }
    async function create(value, parent, root, { identityChecked = false, structural: structuralValue, deferSchedule = false } = {}) {
        if (indexError) throw indexError
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
        const leaf = createLeaf(value, isRoot, { deferIndex: deferIndex && !isRoot })
        await db.leaves.set(leaf.uuid, leaf)
        db.leaves.markDirty?.(leaf)
        const persistenceRoot = rootIds.get(parent?.uuid) ?? parent?.uuid ?? leaf.uuid
        if (isRoot) rootIds.set(leaf.uuid, persistenceRoot)
        await stagePersistence(leaf, 'upsert')
        if (deferIndex && !isRoot) {
            deferLeaf(leaf,handler)
            pendingIndex.add(leaf)
            if (!deferSchedule) schedule()
        }
        else await attach(leaf, insert)
        if (root === "object") identities.set(identityKey(leaf.parent, leaf._id), leaf.uuid)
        if (isRoot) register(leaf)
        configureLeaf(leaf,false)
        return leaf
    }
    async function configureLeaf(leaf,restored=true,initializeIndexes=true){
        if(restored){
            const add=e=>!e.index?insert(e):undefined
            initializeLeaf(leaf,add)
            if(deferIndex){deferLeaf(leaf,handler);if(initializeIndexes)handler.queue(leaf)}
            if(initializeIndexes&&!deferIndex)await attach(leaf,add)
        }
        Object.defineProperty(leaf, Symbol.for("cocreate.deleteLeaf"), {value:()=>remove(leaf)})
        Object.defineProperty(leaf, Symbol.for("cocreate.isLiveLeaf"), {value:async()=>await getLeaf(leaf.uuid)===leaf})
        Object.defineProperty(leaf, Symbol.for("cocreate.markDirty"), {value:async()=>{await db.leaves.markDirty?.(leaf);await stagePersistence(leaf,'upsert')}})
        return leaf
    }
    async function restoreLeaf(value){
        const structuralLeaf=Object.hasOwn(catalog,value.uuid)
        const leaf=createLeaf(value,structuralLeaf,{deferIndex:deferIndex&&!structuralLeaf})
        await db.leaves.set(leaf.uuid,leaf)
        if (structuralLeaf) rootIds.set(leaf.uuid, rootIds.get(leaf.parent) ?? leaf.parent ?? leaf.uuid)
        if(leaf.root==='object')identities.set(identityKey(leaf.parent,leaf._id),leaf.uuid)
        if(structuralLeaf)register(leaf)
        return await configureLeaf(leaf,true,true)
    }
    if (db.leaves) db.leaves.restore = data => restoreLeaf(data.object)

    const remoteReads = new Map()
    async function getLeaf(id) {
        if (typeof id !== 'string' || !id) return undefined
        const local = await db.leaves.get(id)
        if (local || typeof db.readExternal !== 'function') return local
        if (remoteReads.has(id)) return await remoteReads.get(id)
        const task = (async () => {
            const existing = await db.leaves.get(id)
            if (existing) return existing
            const value = await db.readExternal(id)
            if (!value) return undefined
            if (value.uuid !== id) throw new Error(`Persistence returned a mismatched leaf UUID: ${id}`)
            const restored = await restoreLeaf(structuredClone(value))
            db.leaves.markDirty?.(restored)
            return restored
        })()
        remoteReads.set(id, task)
        try { return await task }
        finally { remoteReads.delete(id) }
    }
    db.getLeaf = getLeaf

    async function remove(leaf) {
        if(await getLeaf(leaf.uuid)!==leaf)throw Error('Leaf not found')
        if (Object.hasOwn(catalog, leaf.uuid) && Object.values(catalog).some(child => child.parent === leaf.uuid)) throw Error('Cannot delete a root that still has child leaves')
        const id=leaf.uuid
        await stagePersistence(leaf, 'delete')
        db.deleting.add(id)
        deleted.set(id,leaf)
        await db.leaves.delete(id)
        db.deleting.delete(id)
        if (leaf.root === 'object') identities.delete(identityKey(leaf.parent, leaf._id))
        if (Object.hasOwn(catalog, id)) {
            names.delete(key(leaf.parent, leaf.root, leaf.name))
            delete catalog[id]
            await persistConfig()
        }
        if(deferIndex || activeTraversals){pendingIndex.add(leaf);schedule()}
        else {pendingIndex.add(leaf);await flushLeaf(leaf)}
        return true
    }

    function validateTarget(target) {
        const paths = rootPaths(db.config.roots, target)
        if (!paths.length) throw new Error(`Root is not configured: ${target}`)
        return paths
    }

    async function resolve(envelope, target, { createMissing = false } = {}) {
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
            const matches = await find(parent, name, ref)
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
        for (const value of values) {
            const leaf = await create(value, parent, root, { identityChecked, structural: structuralValue, deferSchedule: true })
            if (leaf) leaves.push(leaf)
        }
        if (deferIndex && !structuralValue && leaves.length) schedule()
        return leaves
    }

    async function matchesRoot(envelope, target, leaf) {
        if (!leaf || leaf.root !== target) return false
        const seen = new Set([leaf.uuid])
        let current = leaf
        while (current.parent !== undefined) {
            if (seen.has(current.parent)) throw Error('Cyclic leaf ancestry')
            seen.add(current.parent)
            current = await getLeaf(current.parent)
            if (!current) return false
            const ref = reference(envelope, current.root)
            if (ref && (ref.uuid ? ref.uuid !== current.uuid : ref.name !== current.name)) return false
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
    return { create, createMany, getLeaf, setReadExternal: read => { db.readExternal = read }, resolve, matchesRoot, visitRange, visitRanges, visitLeaves, remove, validateTarget, configuration, configureLeaf, restoreLeaf, flushIndex, syncIndexCatalog, pendingIndex, hasIdentity: (parent,id) => identities.has(identityKey(parent?.uuid,id)) }
}
