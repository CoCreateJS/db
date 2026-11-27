import { uuid, getValueFromObject, dotNotationToObject, sortData } from '@cocreate/utils'
import { Tree } from './tree/index.js'
import { treeContexts } from './tree/internal.js'
import { executeDisk, emptyStorage } from './disk.js'

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const newUuid = () => uuid().replaceAll('-', '')
const key = (parent, root, name) => JSON.stringify([parent, root, name])

function paths(roots, target) {
    const result = []
    const visit = (node, path, parents) => {
        if (!isRecord(node)) throw new TypeError('Each root configuration node must be an object')
        if (parents.has(node)) throw new Error('Cyclic root configuration')
        parents.add(node)
        for (const [name, child] of Object.entries(node)) {
            if (['__proto__', 'constructor', 'prototype', '$'].includes(name)) throw new Error('Invalid root name')
            const next = [...path, name]
            if (name === target) result.push(next)
            visit(child, next, parents)
        }
        parents.delete(node)
    }
    visit(roots, [], new WeakSet())
    return result
}

function reference(payload, root) {
    const value = payload[root.startsWith('$') ? root.slice(1) : root]
    if (typeof value === 'string' && value) return { name: value }
    if (isRecord(value)) return value.uuid ? { uuid: value.uuid } : value.name ? { name: value.name } : undefined
}

/** Organization roots route envelopes to independent, single-primary Trees. */
export class Organization {
    #config
    #options
    #names = new Map()
    #writes = Promise.resolve()
    #dirty = false
    #error
    #resolving = new Map()
    #creating = new Set()
    constructor(organizationId, options = {}) {
        this.organizationId = organizationId
        this.#options = options
        this.disk = options.disk ?? emptyStorage
        this.persistence = options.persistence ?? emptyStorage
        this.trees = new Map()
        this.roots = Object.freeze({
            get: path => structuredClone(path ? getValueFromObject(this.#config.roots, path) : this.#config.roots),
            execute: async ({ operation, path, data } = {}) => {
                if (operation !== 'set') throw new TypeError(`Unsupported roots operation: ${operation}`)
                if (path !== undefined && typeof path !== 'string') throw new TypeError('Root path must be a string')
                const next = structuredClone(this.#config.roots)
                if (path && dotNotationToObject({ [path]: data }, next) === false) throw new Error('Invalid root path')
                const roots = path ? next : structuredClone(data)
                paths(roots, '')
                for (const [id, record] of Object.entries(this.#config.leaves)) {
                    const old = this.#definition(id)
                    const replacement = this.#definition(id, roots)
                    if (!replacement || Boolean(Object.keys(old).length) !== Boolean(Object.keys(replacement).length))
                        throw new Error('Cannot remove or change structural status of an occupied root')
                }
                const primaries = new Set([...Object.values(this.#config.top), ...Object.keys(this.#config.leaves)])
                for (const uuid of primaries) {
                    const top = Object.entries(this.#config.top).find(([, id]) => id === uuid)?.[0]
                    const before = top ? { [top]: this.#config.roots[top] } : this.#definition(uuid)
                    const after = top ? { [top]: roots[top] } : this.#definition(uuid, roots)
                    for (const [root, children] of Object.entries(before ?? {})) {
                        if (after?.[root] !== undefined && Boolean(Object.keys(children).length) === Boolean(Object.keys(after[root]).length)) continue
                        const tree = await this.getTree(uuid)
                        if (await treeContexts.get(tree).hasRoot(root)) throw new Error('Cannot remove or change structural status of an occupied root')
                    }
                }
                this.#config.roots = roots
                const saved = this.#save()
                for (const tree of this.trees.values()) {
                    const top = Object.entries(this.#config.top).find(([, id]) => id === tree.uuid)
                    const definitions = top ? { [top[0]]: roots[top[0]] } : this.#definition(tree.uuid)
                    if (definitions && (!top || definitions[top[0]] !== undefined)) {
                        await tree.init()
                        await treeContexts.get(tree).configureRoots(definitions)
                    } else this.trees.delete(tree.uuid)
                }
                await saved
                return this.roots.get(path)
            }
        })
    }

    async init(config) {
        paths(config.roots, '')
        const stored = await executeDisk(this, { operation: 'read', kind: 'roots' })
        this.#config = { ...structuredClone(config), ...(stored ? JSON.parse(stored) : {}),
            roots: structuredClone(config.roots), version: config.version }
        this.#config.leaves ??= {}
        this.#config.top ??= {}
        delete this.#config.indexes
        for (const [id, record] of Object.entries(this.#config.leaves)) {
            if (!this.#definition(id)) throw new Error('Invalid configured root path')
            this.#names.set(key(record.parent, record.root, record.name), id)
        }
        return this
    }

    get config() { return structuredClone(this.#config) }
    get pendingIndexCount() {
        let count = 0
        for (const tree of this.trees.values()) count += treeContexts.get(tree)?.pendingIndexCount ?? 0
        return count
    }
    get pruneCandidates() {
        if (this.#dirty || this.#error) return []
        return [...this.trees.values()].filter(tree => treeContexts.get(tree)?.canDrop)
    }

    #definition(id, roots = this.#config.roots) {
        const route = [], seen = new Set()
        while (id !== undefined) {
            if (seen.has(id)) throw new Error('Cyclic configured parent')
            seen.add(id)
            const node = this.#config.leaves[id]
            if (!node) return undefined
            route.unshift(node.root)
            id = node.parent
        }
        for (const root of route) roots = roots?.[root]
        return roots
    }

    #save() {
        this.#dirty = true
        const data = JSON.stringify(this.#config)
        const task = this.#writes.then(async () => {
            await Promise.all([
                executeDisk(this, { operation: 'write', kind: 'roots', data }),
                this.persistence.execute({ operation: 'write', kind: 'roots', organization_id: this.organizationId, data })
            ])
        })
        this.#writes = task
        task.then(() => {
            if (this.#writes === task) { this.#dirty = false; this.#options.onIndexed?.(this) }
        }, error => { this.#error = error })
        return task
    }

    #tree(uuid) {
        let tree = this.trees.get(uuid)
        if (!tree) {
            tree = new Tree()
            tree.uuid = uuid
            tree.organizationId = this.organizationId
            if (this.#options.disk) tree.disk = this.disk
            if (this.#options.persistence) tree.persistence = this.persistence
            if (this.#options.planner) tree.planner = this.#options.planner
            if (this.#options.execute) tree.execute = this.#options.execute
            this.trees.set(uuid, tree)
        }
        return tree
    }

    async getTree(uuid) {
        const top = Object.entries(this.#config.top).find(([, id]) => id === uuid)
        const roots = top ? { [top[0]]: this.#config.roots[top[0]] } : this.#definition(uuid)
        if (!roots) throw new Error(`Primary branch not configured: ${uuid}`)
        const parent = top ? undefined : uuid
        const tree = this.#tree(uuid)
        try { await tree.init({ ...this.#options.treeOptions, uuid, roots, parent }) }
        catch (error) { if (this.trees.get(uuid) === tree) this.trees.delete(uuid); throw error }
        treeContexts.get(tree).onIndexed = () => this.#options.onIndexed?.(this, tree)
        return tree
    }

    async #run(uuid, request) {
        // Pin the selected instance before initialization or storage I/O can yield.
        const tree = this.#tree(uuid)
        tree.active++
        try { return await (await this.getTree(uuid)).execute(request) }
        finally { tree.active--; this.#options.onIndexed?.(this, tree) }
    }

    #top(root) {
        let id = this.#config.top[root]
        if (!id) { this.#config.top[root] = id = newUuid(); this.#save() }
        return id
    }

    async #resolve(payload, target, create) {
        const routes = paths(this.#config.roots, target)
        if (!routes.length) throw new Error(`Root is not configured: ${target}`)
        const eligible = routes.filter(route => route.slice(0, -1).every(root => reference(payload, root)))
        if (eligible.length > 1) throw new Error(`Ambiguous root path for ${target}`)
        if (!eligible.length) {
            if (create) throw new Error('Missing root reference')
            return undefined
        }
        const route = eligible[0]
        let parent, primary = create ? this.#top(route[0]) : this.#config.top[route[0]]
        if (!primary) return []
        for (const root of route.slice(0, -1)) {
            const ref = reference(payload, root)
            let id = ref.uuid ?? this.#names.get(key(parent, root, ref.name))
            let node = this.#config.leaves[id]
            if (node && (node.root !== root || node.parent !== parent)) node = undefined
            if (!node) {
                if (!create) return []
                if (ref.uuid) throw new Error(`Root leaf not found: ${root}`)
                const nameKey = key(parent, root, ref.name)
                let pending = this.#resolving.get(nameKey)
                if (!pending) {
                    pending = (async () => {
                        const response = await this.#run(primary, { method: `${root}.create`, [root]: { name: ref.name } })
                        if (!response.success) throw new Error(response.error.join(', '))
                        const leaf = response[root][0]
                        this.#register(leaf)
                        return leaf.uuid
                    })()
                    this.#resolving.set(nameKey, pending)
                }
                try { id = await pending } finally { if (this.#resolving.get(nameKey) === pending) this.#resolving.delete(nameKey) }
            }
            parent = primary = id
        }
        return [primary]
    }

    #register(leaf) {
        Object.defineProperty(this.#config.leaves, leaf.uuid, { enumerable: true, writable: true, configurable: true,
            value: { root: leaf.root, ...(leaf.parent === undefined ? {} : { parent: leaf.parent }), name: leaf.name } })
        this.#names.set(key(leaf.parent, leaf.root, leaf.name), leaf.uuid)
        this.#save()
    }

    #matches(id, payload) {
        while (id !== undefined) {
            const node = this.#config.leaves[id]
            if (!node) return false
            const ref = reference(payload, node.root)
            if (ref && (ref.uuid ? ref.uuid !== id : ref.name !== node.name)) return false
            id = node.parent
        }
        return true
    }

    async #owner(id, target, payload) {
        let leaf
        for (const tree of this.trees.values()) {
            leaf = treeContexts.get(tree)?.referenceLeaf(id)
            if (leaf) break
        }
        if (!leaf) {
            const data = await executeDisk(this, { operation: 'read', kind: 'leaf', uuid: id })
            if (data) leaf = JSON.parse(data).object
            else leaf = await this.persistence.execute({ operation: 'read', kind: 'leaf', uuid: id, organization_id: this.organizationId })
        }
        if (!leaf || leaf.root !== target || !this.#matches(leaf.parent, payload)) return undefined
        return leaf.parent ?? this.#config.top[target]
    }

    async execute(payload = {}) {
        const [target, operation] = String(payload.method ?? '').split('.')
        const empty = () => ({ ...payload, [target]: [], awareness: [], success: true })
        const reserved = []
        try {
            if (!['create', 'read', 'update', 'delete'].includes(operation)) throw new Error(`Unsupported CRUD method: ${payload.method}`)
            if (operation === 'create' || payload.upsert) {
                const values = Array.isArray(payload[target]) ? payload[target] : [payload[target]]
                for (const value of values) if (value?.uuid) {
                    if (this.#creating.has(value.uuid)) throw new Error('duplicate identity')
                    this.#creating.add(value.uuid)
                    reserved.push(value.uuid)
                }
            }
            const create = operation === 'create' || payload.upsert === true
            let primaries = await this.#resolve(payload, target, create)
            const inputs = payload[target] === undefined ? [] : Array.isArray(payload[target]) ? payload[target] : [payload[target]]
            if (primaries === undefined && inputs.length && inputs.every(value => value.uuid)) {
                primaries = [...new Set((await Promise.all(inputs.map(value => this.#owner(value.uuid, target, payload)))).filter(Boolean))]
            }
            if (primaries === undefined) {
                primaries = []
                for (const [id] of Object.entries(this.#config.leaves))
                    if (Object.hasOwn(this.#definition(id) ?? {}, target) && this.#matches(id, payload)) primaries.push(id)
                if (Object.hasOwn(this.#config.roots, target) && this.#config.top[target]) primaries.push(this.#config.top[target])
            }
            if (!primaries.length) return empty()
            if (operation === 'create' || payload.upsert) for (const value of inputs) {
                if (value.uuid) for (const tree of this.trees.values())
                    if (treeContexts.get(tree)?.referenceLeaf(value.uuid) && (operation === 'create' || !primaries.includes(tree.uuid))) throw new Error('duplicate identity')
                const parent = Object.values(this.#config.top).includes(primaries[0]) ? undefined : primaries[0]
                if (operation === 'create' && this.#names.has(key(parent, target, value.name))) throw new Error('duplicate root name')
            }
            let response
            if (primaries.length === 1) {
                const primary = primaries[0]
                const root = Object.entries(this.#config.top).find(([, id]) => id === primary)?.[0]
                const definitions = root ? this.#config.roots : this.#definition(primary)
                if (operation === 'delete' && Object.keys(definitions?.[target] ?? {}).length) {
                    const selected = await this.#run(primary, { ...payload, method: `${target}.read` })
                    if (!selected.success) return selected
                    for (const leaf of selected[target]) await this.#assertRemovable(leaf.uuid)
                    response = await this.#run(primary, { ...payload, filter: undefined, [target]: selected[target].map(({ uuid }) => ({ uuid })) })
                    if (selected.filter) response.filter = selected.filter
                } else response = await this.#run(primary, payload)
            }
            else {
                // An organization-wide request combines independent table results.
                const filter = payload.filter?.isFilter === false ? undefined : payload.filter
                if (!filter && !inputs.length) return empty()
                const start = filter?.startingIndex ?? filter?.index ?? 0
                const limit = filter ? filter.limit ?? 50 : 0
                if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(limit) || limit < 0) throw new Error('invalid pagination')
                const selected = []
                for (const id of primaries) {
                    const result = await this.#run(id, { ...payload, method: `${target}.read`, filter: { ...filter, startingIndex: 0, index: 0, limit: 0 } })
                    if (!result.success) return result
                    selected.push(...result[target])
                }
                if (filter?.sort?.length) sortData(selected, [...filter.sort, { key: 'uuid', direction: 'asc' }])
                const page = selected.slice(start, limit ? start + limit : undefined)
                response = { ...empty(), [target]: [], awareness: [], ...(filter ? { filter: { ...filter, startingIndex: start, index: start + page.length } } : {}) }
                for (const leaf of page) {
                    if (operation === 'read') response[target].push(leaf)
                    else {
                        if (operation === 'delete') await this.#assertRemovable(leaf.uuid)
                        const original = inputs.find(value => value.uuid === leaf.uuid) ?? inputs[0] ?? {}
                        const result = await this.#run(leaf.parent ?? this.#config.top[target], { ...payload, filter: undefined, [target]: { ...original, uuid: leaf.uuid } })
                        if (!result.success) return result
                        response[target].push(...result[target])
                        if (result.$update) (response.$update ??= []).push(...result.$update)
                    }
                    response.awareness.push(leaf.uuid)
                }
            }
            if (response.success && (create || operation === 'delete')) for (const leaf of response[target]) {
                const roots = leaf.parent === undefined ? this.#config.roots : this.#definition(leaf.parent)
                if (!Object.keys(roots?.[target] ?? {}).length) continue
                if (operation === 'delete') {
                    delete this.#config.leaves[leaf.uuid]
                    this.trees.delete(leaf.uuid)
                    this.#names.delete(key(leaf.parent, leaf.root, leaf.name))
                    this.#save()
                } else this.#register(leaf)
            }
            return response
        } catch (error) { return { ...payload, success: false, error: [error.message] } }
        finally { for (const uuid of reserved) this.#creating.delete(uuid) }
    }

    async #assertRemovable(uuid) {
        if (!Object.hasOwn(this.#config.leaves, uuid)) return
        if (Object.values(this.#config.leaves).some(node => node.parent === uuid)) throw new Error('Cannot delete a root that still has child leaves')
        const child = await this.getTree(uuid)
        if (child.active || treeContexts.get(child).pendingIndexCount || treeContexts.get(child).leafCount || child.config.indexes.some(index => index.key === 'root' && index.count > 0))
            throw new Error('Cannot delete a root that still has child leaves')
    }

    async prune({ uuid, limit = Infinity } = {}) {
        if (limit !== Infinity && (!Number.isInteger(limit) || limit < 0)) throw new TypeError('Pruning limit must be a non-negative integer')
        if (uuid !== undefined) {
            const tree = this.trees.get(uuid)
            if (!limit || this.#dirty || this.#error || !treeContexts.get(tree)?.canDrop) return { count: 0 }
            this.trees.delete(uuid)
            return { count: 1 }
        }
        const candidates = this.pruneCandidates.sort((a, b) => a.weight - b.weight || a.uuid.localeCompare(b.uuid))
        let count = 0
        for (const tree of candidates) {
            if (count >= limit) break
            // No index/leaf traversal: removing the owner releases its entire graph.
            if (!treeContexts.get(tree).canDrop || this.trees.get(tree.uuid) !== tree) continue
            this.trees.delete(tree.uuid)
            count++
        }
        return { count }
    }

    async close() {
        await Promise.all([...this.trees.values()].map(tree => tree.close()))
        await this.#writes
        if (this.#error) throw this.#error
        this.trees.clear()
    }
}
