import { uuid, getValueFromObject, dotNotationToObject } from '@cocreate/utils'
import { createArtifact, attach, type, updateArtifact, deferArtifact, reconcileArtifact, restoreArtifactIndex } from './artifact.js'
import { Tree } from './tree/index.js'
import { queryTree } from './tree/query.js'

const uuidValue = () => uuid().replaceAll('-', '')
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)

export function defaultConfiguration() {
    return {
        version: '1.0.0',
        scopes: {
            $organization_id: { storage: { database: { array: { object: {}, index: {} } } } }
        }
    }
}

export function createConfiguration({ config, scopes, version } = {}) {
    const defaults = defaultConfiguration()
    const source = config && isRecord(config) ? config : {}
    const activeScopes = scopes ?? source.scopes ?? defaults.scopes
    if (!isRecord(activeScopes)) throw new TypeError('scopes must be an ordinary object')
    return { version: version ?? source.version ?? defaults.version, scopes: structuredClone(activeScopes), artifacts: structuredClone(source.artifacts ?? {}) }
}

function scopePaths(scopes, target) {
    const result = []
    const visit = (node, path, parents) => {
        if (!isRecord(node)) throw new TypeError('Each scope configuration node must be an object')
        if (parents.has(node)) throw new Error('Cyclic scope configuration')
        parents.add(node)
        for (const [name, child] of Object.entries(node)) {
            if (['__proto__','constructor','prototype'].includes(name)) throw Error('Invalid scope name')
            if (name === '$') throw new Error('Invalid dynamic scope name')
            const next = [...path, name]
            if (name === target) result.push(next)
            if (isRecord(child)) visit(child, next, parents)
            else throw new TypeError(`Scope ${name} must contain an object`)
        }
        parents.delete(node)
    }
    visit(scopes, [], new WeakSet())
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

function insertEntry(tree, size, leafSize, entry, local) {
    let types = tree.get(entry.key)
    if (!types) tree.set(entry.key, types = new Map())
    let index = types.get(type(entry.value))
    if (!index) types.set(type(entry.value), index = new Tree(size,local,entry.key,leafSize))
    entry.insert(index)
}

export function createScopeManager({ db, size = 1024, leafSize = size, deferIndex = false }) {
    const pendingIndex = new Set()
    const deleted = db.deleted = new Map()
    db.deleting ??= new Set()
    const context = { artifacts: db.artifacts, tree: db.tree, pendingIndex, get indexError() { return indexError } }
    let scheduled, indexError
    const insert = entry => insertEntry(db.tree, size, leafSize, entry, db.local)
    function flushArtifact(artifact) {
        if(indexError)throw indexError
        if(!pendingIndex.has(artifact))return
        try {
            if(deleted.get(artifact.uuid) === artifact) {
                if(db.deleting.has(artifact.uuid))return
                for(const entry of Object.values(artifact.getIndex()))if(entry.partition)entry.tree.remove(entry)
                deleted.delete(artifact.uuid)
            } else reconcileArtifact(artifact,insert)
            pendingIndex.delete(artifact)
        }
        catch(error){indexError=error;throw error}
    }
    const handler={queue(artifact){pendingIndex.add(artifact);schedule()},flush:flushArtifact}
    function drain(limit = Infinity) {
        if (indexError) throw indexError
        for (const artifact of pendingIndex) {
            if (limit-- <= 0) break
            try { flushArtifact(artifact) }
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

    function select(parent, scope, query = {}, limit = Infinity) {
        const criteria = { ...query, scope }
        if (parent) criteria.parent = parent.uuid
        else criteria.parent = undefined
        return queryTree(context, criteria, limit)
    }

    const names = new Map()
    const identities = new Map()
    const identityKey = (parent, id) => JSON.stringify([parent, id])
    const key = (parent, scope, name) => JSON.stringify([parent, scope, name])
    const catalog = db.config.artifacts
    const dynamicKeys = new Set()
    function refreshDynamicKeys() {
        dynamicKeys.clear()
        function visit(node) {
            for (const [scope, child] of Object.entries(node)) {
                if (scope.startsWith('$')) dynamicKeys.add(scope.slice(1))
                visit(child)
            }
        }
        visit(db.config.scopes)
    }
    function structural(parent, scope) {
        let node = db.config.scopes
        const path = []
        while (parent) { path.push(parent.scope); parent = db.artifacts.get(parent.parent) }
        for (let i = path.length - 1; i >= 0; i--) node = node?.[path[i]]
        return Object.keys(node?.[scope] ?? {}).length > 0
    }
    function register(artifact) {
        const { uuid, scope, parent, name } = artifact
        const k = key(parent, scope, name)
        if (names.has(k)) throw Error('duplicate scope name')
        names.set(k, artifact)
        Object.defineProperty(catalog, uuid, { value: { scope, ...(parent === undefined ? {} : { parent }), name }, enumerable: true, writable: true, configurable: true })
    }
    function find(parent, scope, ref) {
        if (!ref) return []
        const artifact = ref.uuid ? db.artifacts.get(ref.uuid) : names.get(key(parent?.uuid, scope, ref.name))
        return artifact && db.artifacts.get(artifact.uuid)===artifact && artifact.scope === scope && artifact.parent === parent?.uuid ? [artifact] : []
    }
    function configuration(writable = true) {
        const snapshot = structuredClone(db.config)
        Object.defineProperties(snapshot, {
            getValue: { value: path => structuredClone(getValueFromObject(db.config, path)) },
            setValue: { value: (path, value) => {
                if (!writable) throw Error('Configuration updates require the primary')
                if (typeof path !== 'string' || !/^scopes(?:\.[^.[\]]+)*$/.test(path) || path.split('.').some(k => ['__proto__','constructor','prototype'].includes(k))) throw Error('Only scope definitions can be edited directly')
                const next = structuredClone(db.config)
                if (dotNotationToObject({ [path]: structuredClone(value) }, next) === false) throw Error('Invalid configuration update')
                scopePaths(next.scopes, '')
                for (const artifact of db.artifacts.values()) {
                    let node = next.scopes
                    const path = [artifact.scope]
                    let parent = db.artifacts.get(artifact.parent)
                    while (parent) { path.unshift(parent.scope); parent = db.artifacts.get(parent.parent) }
                    for (const part of path) node = node?.[part]
                    if (!isRecord(node)) throw Error('Cannot remove an occupied scope')
                    if (Boolean(Object.keys(node).length) !== Object.hasOwn(catalog, artifact.uuid)) throw Error('Cannot change structural status of an occupied scope')
                }
                db.config.scopes = next.scopes
                refreshDynamicKeys()
                return configuration()
            } }
        })
        return snapshot
    }
    function create(value, parent, scope) {
        if (indexError) throw indexError
        if (!isRecord(value)) throw new TypeError(`${scope} must contain an object`)
        value.scope = scope
        if (parent) value.parent = parent.uuid
        else delete value.parent
        value.uuid ??= uuidValue()
        const isScope = structural(parent, scope)
        if (isScope && (typeof value.name !== 'string' || !value.name || names.has(key(parent?.uuid, scope, value.name)))) throw Error('Invalid or duplicate scope name')
        if (scope === 'object') value._id ??= uuidValue().slice(0, 24)
        if (scope === "object" && identities.has(identityKey(value.parent, value._id))) throw Error("duplicate identity")
        if (db.artifacts.has(value.uuid) || deleted.has(value.uuid)) throw new Error(`Artifact UUID already exists: ${value.uuid}`)
        const artifact = createArtifact(value, isScope)
        if (deferIndex && !isScope) { deferArtifact(artifact,handler); handler.queue(artifact) }
        else attach(artifact, insert)
        db.artifacts.set(artifact.uuid, artifact)
        if (scope === "object") identities.set(identityKey(artifact.parent, artifact._id), artifact.uuid)
        if (isScope) register(artifact)
        configureArtifact(artifact,false)
        return artifact
    }
    function configureArtifact(artifact,restored=true){
        if(restored){if(deferIndex)deferArtifact(artifact,handler);else attach(artifact,e=>{if(!e.partition)insert(e)})}
        Object.defineProperty(artifact, Symbol.for("cocreate.deleteArtifact"), {value:()=>remove(artifact)})
        Object.defineProperty(artifact, Symbol.for("cocreate.isLiveArtifact"), {value:()=>db.artifacts.get(artifact.uuid)===artifact})
        return artifact
    }

    async function remove(artifact) {
        if(db.artifacts.get(artifact.uuid)!==artifact)throw Error('Artifact not found')
        if (Object.hasOwn(catalog, artifact.uuid) && queryTree(context, { parent: artifact.uuid }, 1).length) throw Error('Cannot delete a scope that still has child artifacts')
        const id=artifact.uuid
        db.deleting.add(id)
        deleted.set(id,artifact)
        db.artifacts.delete(id)
        try { if(db.local)await db.local.deleteArtifact(id) }
        catch(error){db.artifacts.set(id,artifact);deleted.delete(id);throw error}
        finally{db.deleting.delete(id)}
        if (artifact.scope === 'object') identities.delete(identityKey(artifact.parent, artifact._id))
        if (Object.hasOwn(catalog, id)) {
            names.delete(key(artifact.parent, artifact.scope, artifact.name))
            delete catalog[id]
        }
        if(deferIndex){pendingIndex.add(artifact);schedule()}
        else {pendingIndex.add(artifact);flushArtifact(artifact)}
        return true
    }

    function validateTarget(target) {
        const paths = scopePaths(db.config.scopes, target)
        if (!paths.length) throw new Error(`Scope is not configured: ${target}`)
        return paths
    }

    function direct(envelope, target, id) {
        const artifact = db.artifacts.get(id)
        if (!artifact || artifact.scope !== target) return
        // Validate existing ancestry rather than resolving names through indexes.
        // Explicit references remain constraints.
        const ancestors = []
        const seen = new Set([id])
        let current = artifact
        while (current.parent !== undefined) {
            if (seen.has(current.parent)) throw Error('Cyclic artifact ancestry')
            seen.add(current.parent)
            current = db.artifacts.get(current.parent)
            if (!current) return
            const key = current.scope.startsWith('$') ? current.scope.slice(1) : current.scope
            if (Object.hasOwn(envelope, key)) {
                const ref = reference(envelope, current.scope)
                if (!ref || (ref.uuid ? ref.uuid !== current.uuid : ref.name !== current.name)) return
            }
            ancestors.push(current)
        }
        for (const key of dynamicKeys) {
            if (Object.hasOwn(envelope, key) && artifact.scope !== `$${key}` && !ancestors.some(a => a.scope === `$${key}`)) return
        }
        let node = db.config.scopes
        for (let i = ancestors.length - 1; i >= 0; i--) {
            const key = ancestors[i].scope
            if (!isRecord(node) || !Object.hasOwn(node, key)) return
            node = node[key]
        }
        if (!isRecord(node) || !Object.hasOwn(node, target) || !isRecord(node[target])) return
        return artifact
    }

    function resolve(envelope, target, { createMissing = false } = {}) {
        const paths = validateTarget(target)
        const eligible = paths.filter(path => path.slice(0, -1).every(name => reference(envelope, name)))
        if (!eligible.length) {
            const name = paths[0].slice(0, -1).find(part => !reference(envelope, part))
            throw new Error(`Missing scope reference${name ? `: ${name}` : ''}`)
        }
        if (eligible.length > 1) throw new Error(`Ambiguous scope path for ${target}`)
        const path = eligible[0], created = []
        let parent
        for (const name of path.slice(0, -1)) {
            const ref = reference(envelope, name)
            const matches = find(parent, name, ref)
            if (matches.length > 1) throw new Error(`Ambiguous ${name} scope reference`)
            let artifact = matches[0]
            if (!artifact) {
                if (!createMissing) return { target, parent, created, missing: true, path }
                if (ref.uuid) throw new Error(`Scope artifact not found: ${name}`)
                artifact = create({ name: ref.name }, parent, name)
                created.push(artifact)
            }
            parent = artifact
        }
        return { target, parent, created, missing: false, path }
    }

    scopePaths(db.config.scopes, '')
    refreshDynamicKeys()
    if (!isRecord(catalog)) throw Error('Invalid scope catalog')
    const pending = new Map(Object.entries(catalog))
    for (const id of pending.keys()) delete catalog[id]
    while (pending.size) {
        const count = pending.size
        for (const [id, value] of pending) {
            if (!isRecord(value) || typeof value.scope !== 'string') throw Error('Invalid configured scope identity')
            const parent = db.artifacts.get(value.parent)
            if (value.parent !== undefined && !parent) continue
            if (!structural(parent, value.scope)) throw Error('Invalid configured scope identity')
            let node = db.config.scopes
            const path = [value.scope]
            let ancestor = parent
            while (ancestor) { path.unshift(ancestor.scope); ancestor = db.artifacts.get(ancestor.parent) }
            for (const part of path) node = node?.[part]
            if (!isRecord(node)) throw Error('Invalid configured scope path')
            create({ uuid: id, name: value.name }, parent, value.scope)
            pending.delete(id)
        }
        if (pending.size === count) throw Error('Missing or cyclic configured parent')
    }
    return { create, resolve, select, remove, direct, validateTarget, configuration, configureArtifact, flushIndex, pendingIndex, hasIdentity: (parent,id) => identities.has(identityKey(parent?.uuid,id)) }
}
