import { uuid } from '@cocreate/utils'
import { createArtifact, attach, type } from './artifact.js'
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
    return { version: version ?? source.version ?? defaults.version, scopes: activeScopes }
}

function scopePaths(scopes, target) {
    const result = []
    const visit = (node, path, parents) => {
        if (!isRecord(node)) throw new TypeError('Each scope configuration node must be an object')
        if (parents.has(node)) throw new Error('Cyclic scope configuration')
        parents.add(node)
        for (const [name, child] of Object.entries(node)) {
            if (name.startsWith('$') && name !== '$organization_id') throw new Error(`Unsupported dynamic scope: ${name}`)
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
    if (name === '$organization_id') {
        const value = envelope.organization_id
        return typeof value === 'string' && value ? { name: value } : undefined
    }
    const value = envelope[name]
    if (typeof value === 'string' && value) return { name: value }
    if (isRecord(value)) {
        if (typeof value.uuid === 'string' && value.uuid) return { uuid: value.uuid }
        if (typeof value.name === 'string' && value.name) return { name: value.name }
    }
}

function insertEntry(tree, size, entry) {
    let types = tree.get(entry.key)
    if (!types) tree.set(entry.key, types = new Map())
    let index = types.get(type(entry.value))
    if (!index) types.set(type(entry.value), index = new Tree(size))
    entry.insert(index)
}

export function createScopeManager({ db, size = 64 }) {
    const context = { artifacts: db.artifacts, tree: db.tree }

    function select(parent, scope, query = {}, limit = Infinity) {
        const criteria = { ...query, scope }
        if (parent) criteria.parent = parent.uuid
        else delete criteria.parent
        return queryTree(context, criteria, limit)
    }

    function find(parent, scope, ref) {
        if (!ref) return []
        if (ref.uuid) {
            const artifact = db.artifacts.get(ref.uuid)
            return artifact && artifact.scope === scope && artifact.parent === parent?.uuid ? [artifact] : []
        }
        return select(parent, scope, { name: ref.name }, 2)
    }

    function create(value, parent, scope) {
        if (!isRecord(value)) throw new TypeError(`${scope} must contain an object`)
        value.scope = scope
        if (parent) value.parent = parent.uuid
        else delete value.parent
        value.uuid ??= uuidValue()
        if (scope === 'object') value._id ??= uuidValue().slice(0, 24)
        if (db.artifacts.has(value.uuid)) throw new Error(`Artifact UUID already exists: ${value.uuid}`)
        const artifact = createArtifact(value)
        attach(artifact, entry => insertEntry(db.tree, size, entry))
        db.artifacts.set(artifact.uuid, artifact)
        return artifact
    }

    function remove(artifact) {
        const children = queryTree(context, { parent: artifact.uuid }, 1)
        if (children.length) throw new Error('Cannot delete a scope that still has child artifacts')
        for (const entry of Object.values(artifact.getIndex()))
            if (entry.partition) entry.tree.remove(entry)
        db.artifacts.delete(artifact.uuid)
    }

    function validateTarget(target) {
        const paths = scopePaths(db.scopes, target)
        if (!paths.length) throw new Error(`Scope is not configured: ${target}`)
        return paths
    }

    function direct(envelope, target, id) {
        const artifact = db.artifacts.get(id)
        if (!artifact || artifact.scope !== target) return
        // Validate existing ancestry rather than resolving names through indexes.
        // Explicit references remain constraints, including organization_id.
        const ancestors = []
        const seen = new Set([id])
        let current = artifact
        while (current.parent !== undefined) {
            if (seen.has(current.parent)) throw Error('Cyclic artifact ancestry')
            seen.add(current.parent)
            current = db.artifacts.get(current.parent)
            if (!current) return
            const key = current.scope === '$organization_id' ? 'organization_id' : current.scope
            if (Object.hasOwn(envelope, key)) {
                const ref = reference(envelope, current.scope)
                if (!ref || (ref.uuid ? ref.uuid !== current.uuid : ref.name !== current.name)) return
            }
            ancestors.push(current)
        }
        if (Object.hasOwn(envelope, 'organization_id') && !ancestors.some(a => a.scope === '$organization_id') && artifact.scope !== '$organization_id') return
        let node = db.scopes
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

    return { create, resolve, select, remove, direct, validateTarget }
}
