import { uuid, getValueFromObject, dotNotationToObject } from '@cocreate/utils'
import { createLeaf, attach, initializeLeaf, type, updateLeaf, deferLeaf, reconcileLeaf, restoreLeafIndex } from './leaf.js'
import { Tree } from './tree/index.js'
import { queryTree } from './tree/query.js'

const uuidValue = () => uuid().replaceAll('-', '')
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)

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

function insertEntry(tree, size, leafSize, entry, local, leaves) {
    let types = tree.get(entry.key)
    if (!types) tree.set(entry.key, types = new Map())
    let index = types.get(type(entry.value))
    if (!index) {
        types.set(type(entry.value), index = new Tree(size,local,entry.key,leafSize))
        index.resolveLeaf = id => leaves.get(id)
    }
    entry.insert(index)
}

export function createRootManager({ db, size = 1024, leafSize = size, deferIndex = false, persistConfig = () => {} }) {
    const pendingIndex = new Set()
    const deleted = db.deleted = new Map()
    db.deleting ??= new Set()
    const context = { leaves: db.leaves, tree: db.tree, pendingIndex, get indexError() { return indexError } }
    let scheduled, indexError, initializing = true
    for (const route of db.config.indexes) {
        if (!route || typeof route.key !== 'string' || typeof route.type !== 'string' || typeof route.uuid !== 'string') throw Error('Invalid index root catalog')
        const tree = new Tree(size,db.local,route.key,leafSize,route.uuid)
        let types = db.tree.get(route.key)
        if (!types) db.tree.set(route.key,types = new Map())
        types.set(route.type,tree)
    }
    const insert = entry => insertEntry(db.tree, size, leafSize, entry, db.local, db.leaves)
    function flushLeaf(leaf) {
        if(indexError)throw indexError
        if(!pendingIndex.has(leaf))return
        try {
            if(deleted.get(leaf.uuid) === leaf) {
                if(db.deleting.has(leaf.uuid))return
                for(const entry of Object.values(leaf.getIndex()))if(entry.index)entry.tree.remove(entry)
                deleted.delete(leaf.uuid)
            } else reconcileLeaf(leaf,insert)
            pendingIndex.delete(leaf)
        }
        catch(error){indexError=error;throw error}
    }
    const handler={queue(leaf){pendingIndex.add(leaf);schedule()},flush:flushLeaf}
    function drain(limit = Infinity) {
        if (indexError) throw indexError
        for (const leaf of pendingIndex) {
            if (limit-- <= 0) break
            try { flushLeaf(leaf) }
            catch (error) { indexError = error; throw error }
        }
    }
    function schedule() {
        if (scheduled || !pendingIndex.size || indexError) return
        scheduled = setImmediate(() => {
            scheduled = undefined
            try { drain(64) } catch { return }
            schedule()
        })
    }
    function flushIndex() {
        if (scheduled) clearImmediate(scheduled)
        scheduled = undefined
        drain()
    }

    function syncIndexCatalog() {
        db.config.indexes = []
        for (const [key,types] of db.tree) for (const [valueType,tree] of types)
            db.config.indexes.push({key,type:valueType,uuid:tree.root.uuid})
    }

    function select(parent, root, query = {}, limit = Infinity) {
        const criteria = { ...query, root }
        if (parent) criteria.parent = parent.uuid
        else criteria.parent = undefined
        return queryTree(context, criteria, limit)
    }

    const names = new Map()
    const identities = new Map()
    const identityKey = (parent, id) => JSON.stringify([parent, id])
    const key = (parent, root, name) => JSON.stringify([parent, root, name])
    const catalog = db.config.leaves
    function persistenceRoot(leaf) {
        let root = leaf
        let parentId = leaf.parent
        while (parentId) {
            const parent = db.leaves.get(parentId)
            if (!parent) break
            root = parent
            parentId = parent.parent
        }
        return root.uuid
    }
    function markPersistence(leaf, op = 'upsert') {
        const root = persistenceRoot(leaf)
        const group = db.persistence.pending[root] ??= Object.create(null)
        const previous = group[leaf.uuid]
        group[leaf.uuid] = op
        return { root, previous }
    }
    function restorePending(root, id, previous) {
        const group = db.persistence.pending[root]
        if (!group) return
        if (previous === undefined) delete group[id]
        else group[id] = previous
        if (!Object.keys(group).length) delete db.persistence.pending[root]
    }
    function clearPersistencePending(leaf) {
        if (!leaf?.uuid) return false
        let root = persistenceRoot(leaf)
        let group = db.persistence.pending[root]
        if (!group || !Object.hasOwn(group, leaf.uuid)) {
            const found = Object.entries(db.persistence.pending).find(([, entries]) => Object.hasOwn(entries, leaf.uuid))
            if (!found) return false
            root = found[0]
            group = found[1]
        }
        delete group[leaf.uuid]
        if (!Object.keys(group).length) delete db.persistence.pending[root]
        return true
    }
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
    function structural(parent, root) {
        let node = db.config.roots
        const path = []
        while (parent) { path.push(parent.root); parent = db.leaves.get(parent.parent) }
        for (let i = path.length - 1; i >= 0; i--) node = node?.[path[i]]
        return Object.keys(node?.[root] ?? {}).length > 0
    }
    function register(leaf) {
        const { uuid, root, parent, name } = leaf
        const k = key(parent, root, name)
        if (names.has(k) && names.get(k).uuid !== uuid) throw Error('duplicate root name')
        names.set(k, leaf)
        Object.defineProperty(catalog, uuid, { value: { root, ...(parent === undefined ? {} : { parent }), name }, enumerable: true, writable: true, configurable: true })
        if (!initializing) persistConfig()
    }
    function find(parent, root, ref) {
        if (!ref) return []
        const leaf = ref.uuid ? db.leaves.get(ref.uuid) : names.get(key(parent?.uuid, root, ref.name))
        return leaf && db.leaves.get(leaf.uuid)===leaf && leaf.root === root && leaf.parent === parent?.uuid ? [leaf] : []
    }
    function configuration(writable = true) {
        const snapshot = structuredClone(db.config)
        Object.defineProperties(snapshot, {
            getValue: { value: path => structuredClone(getValueFromObject(db.config, path)) },
            setValue: { value: (path, value) => {
                if (!writable) throw Error('Configuration updates require the primary')
                if (typeof path !== 'string' || !/^roots(?:\.[^.[\]]+)*$/.test(path) || path.split('.').some(k => ['__proto__','constructor','prototype'].includes(k))) throw Error('Only root definitions can be edited directly')
                const next = structuredClone(db.config)
                if (dotNotationToObject({ [path]: structuredClone(value) }, next) === false) throw Error('Invalid configuration update')
                rootPaths(next.roots, '')
                for (const leaf of db.leaves.values()) {
                    let node = next.roots
                    const path = [leaf.root]
                    let parent = db.leaves.get(leaf.parent)
                    while (parent) { path.unshift(parent.root); parent = db.leaves.get(parent.parent) }
                    for (const part of path) node = node?.[part]
                    if (!isRecord(node)) throw Error('Cannot remove an occupied root')
                    if (Boolean(Object.keys(node).length) !== Object.hasOwn(catalog, leaf.uuid)) throw Error('Cannot change structural status of an occupied root')
                }
                db.config.roots = next.roots
                refreshDynamicKeys()
                persistConfig()
                return configuration()
            } }
        })
        return snapshot
    }
    function create(value, parent, root) {
        if (indexError) throw indexError
        if (!isRecord(value)) throw new TypeError(`${root} must contain an object`)
        value.root = root
        if (parent) value.parent = parent.uuid
        else delete value.parent
        value.uuid ??= uuidValue()
        const isRoot = structural(parent, root)
        if (isRoot && (typeof value.name !== 'string' || !value.name || names.has(key(parent?.uuid, root, value.name)))) throw Error('Invalid or duplicate root name')
        if (root === 'object') value._id ??= uuidValue().slice(0, 24)
        if (root === "object" && identities.has(identityKey(value.parent, value._id))) throw Error("duplicate identity")
        if (db.leaves.has(value.uuid) || deleted.has(value.uuid)) throw new Error(`Leaf UUID already exists: ${value.uuid}`)
        const leaf = createLeaf(value, isRoot)
        db.leaves.set(leaf.uuid, leaf)
        markPersistence(leaf)
        db.leaves.markDirty?.(leaf)
        if (deferIndex && !isRoot) { deferLeaf(leaf,handler); handler.queue(leaf) }
        else attach(leaf, insert)
        if (root === "object") identities.set(identityKey(leaf.parent, leaf._id), leaf.uuid)
        if (isRoot) register(leaf)
        configureLeaf(leaf,false)
        return leaf
    }
    function configureLeaf(leaf,restored=true,initializeIndexes=true){
        if(restored){
            const add=e=>{if(!e.index)insert(e)}
            initializeLeaf(leaf,add)
            if(deferIndex)deferLeaf(leaf,handler)
            if(initializeIndexes&&!deferIndex)attach(leaf,add)
        }
        Object.defineProperty(leaf, Symbol.for("cocreate.deleteLeaf"), {value:()=>remove(leaf)})
        Object.defineProperty(leaf, Symbol.for("cocreate.isLiveLeaf"), {value:()=>db.leaves.get(leaf.uuid)===leaf})
        Object.defineProperty(leaf, Symbol.for("cocreate.markDirty"), {value:()=>{markPersistence(leaf);db.leaves.markDirty?.(leaf)}})
        return leaf
    }
    function restoreLeaf(value){
        const structuralLeaf=Object.hasOwn(catalog,value.uuid)
        const leaf=createLeaf(value,structuralLeaf)
        db.leaves.set(leaf.uuid,leaf)
        if(leaf.root==='object')identities.set(identityKey(leaf.parent,leaf._id),leaf.uuid)
        if(structuralLeaf)register(leaf)
        return configureLeaf(leaf,true,false)
    }
    if (db.leaves) db.leaves.restore = data => restoreLeaf(data.object)

    async function remove(leaf) {
        if(db.leaves.get(leaf.uuid)!==leaf)throw Error('Leaf not found')
        if (Object.hasOwn(catalog, leaf.uuid) && queryTree(context, { parent: leaf.uuid }, 1).length) throw Error('Cannot delete a root that still has child leaves')
        const id=leaf.uuid
        db.deleting.add(id)
        deleted.set(id,leaf)
        db.leaves.delete(id)
        const pending = markPersistence(leaf, 'delete')
        try { if(db.local)await db.local.deleteLeaf(id) }
        catch(error){restorePending(pending.root,id,pending.previous);db.leaves.set(id,leaf);deleted.delete(id);throw error}
        finally{db.deleting.delete(id)}
        if (leaf.root === 'object') identities.delete(identityKey(leaf.parent, leaf._id))
        if (Object.hasOwn(catalog, id)) {
            names.delete(key(leaf.parent, leaf.root, leaf.name))
            delete catalog[id]
            persistConfig()
        }
        if(deferIndex){pendingIndex.add(leaf);schedule()}
        else {pendingIndex.add(leaf);flushLeaf(leaf)}
        return true
    }

    function validateTarget(target) {
        const paths = rootPaths(db.config.roots, target)
        if (!paths.length) throw new Error(`Root is not configured: ${target}`)
        return paths
    }

    function direct(envelope, target, id) {
        const leaf = db.leaves.get(id)
        if (!leaf || leaf.root !== target) return
        // Validate existing ancestry rather than resolving names through indexes.
        // Explicit references remain constraints.
        const ancestors = []
        const seen = new Set([id])
        let current = leaf
        while (current.parent !== undefined) {
            if (seen.has(current.parent)) throw Error('Cyclic leaf ancestry')
            seen.add(current.parent)
            current = db.leaves.get(current.parent)
            if (!current) return
            const key = current.root.startsWith('$') ? current.root.slice(1) : current.root
            if (Object.hasOwn(envelope, key)) {
                const ref = reference(envelope, current.root)
                if (!ref || (ref.uuid ? ref.uuid !== current.uuid : ref.name !== current.name)) return
            }
            ancestors.push(current)
        }
        for (const key of dynamicKeys) {
            if (Object.hasOwn(envelope, key) && leaf.root !== `$${key}` && !ancestors.some(a => a.root === `$${key}`)) return
        }
        let node = db.config.roots
        for (let i = ancestors.length - 1; i >= 0; i--) {
            const key = ancestors[i].root
            if (!isRecord(node) || !Object.hasOwn(node, key)) return
            node = node[key]
        }
        if (!isRecord(node) || !Object.hasOwn(node, target) || !isRecord(node[target])) return
        return leaf
    }

    function resolve(envelope, target, { createMissing = false } = {}) {
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
            const matches = find(parent, name, ref)
            if (matches.length > 1) throw new Error(`Ambiguous ${name} root reference`)
            let leaf = matches[0]
            if (!leaf) {
                if (!createMissing) return { target, parent, created, missing: true, path }
                if (ref.uuid) throw new Error(`Root leaf not found: ${name}`)
                leaf = create({ name: ref.name }, parent, name)
                created.push(leaf)
            }
            parent = leaf
        }
        return { target, parent, created, missing: false, path }
    }

    rootPaths(db.config.roots, '')
    refreshDynamicKeys()
    if (!isRecord(catalog)) throw Error('Invalid root catalog')
    const pending = new Map(Object.entries(catalog))
    while (pending.size) {
        const count = pending.size
        for (const [id, value] of pending) {
            if (!isRecord(value) || typeof value.root !== 'string') throw Error('Invalid configured root identity')
            const parent = db.leaves.get(value.parent)
            if (value.parent !== undefined && !parent) continue
            if (!structural(parent, value.root)) throw Error('Invalid configured root identity')
            let node = db.config.roots
            const path = [value.root]
            let ancestor = parent
            while (ancestor) { path.unshift(ancestor.root); ancestor = db.leaves.get(ancestor.parent) }
            for (const part of path) node = node?.[part]
            if (!isRecord(node)) throw Error('Invalid configured root path')
            const leaf = db.leaves.get(id)
            if (leaf) {
                if (leaf.root !== value.root || leaf.parent !== value.parent || leaf.name !== value.name) throw Error('Configured root leaf does not match its catalog')
                if (!names.has(key(value.parent, value.root, value.name))) register(leaf)
            } else create({ uuid: id, name: value.name }, parent, value.root)
            pending.delete(id)
        }
        if (pending.size === count) throw Error('Missing or cyclic configured parent')
    }
    initializing = false
    return { create, resolve, select, remove, direct, validateTarget, configuration, configureLeaf, restoreLeaf, flushIndex, syncIndexCatalog, clearPersistencePending, pendingIndex, hasIdentity: (parent,id) => identities.has(identityKey(parent?.uuid,id)) }
}
