import { LeafTier } from './leaves.js'
import { LocalTier } from './local-core.js'
import { createRootManager } from './manager.js'
import { updateLeaf } from './leaf.js'
import { getValueFromObject } from '@cocreate/utils'

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const emptyStorage = Object.freeze({
    async execute(request) {
        if (request.operation === 'read') return undefined
        if (request.operation === 'has') return false
        if (request.operation === 'list') return []
        return request
    }
})
const encodeUuid = value => typeof Buffer === 'function'
    ? Buffer.from(value).toString('hex')
    : Array.from(new TextEncoder().encode(value), byte => byte.toString(16).padStart(2, '0')).join('')
const decodeUuid = value => typeof Buffer === 'function'
    ? Buffer.from(value, 'hex').toString()
    : new TextDecoder().decode(new Uint8Array(value.match(/.{2}/g)?.map(pair => Number.parseInt(pair, 16)) ?? []))

const organizationPath = organizationId => encodeURIComponent(organizationId).replaceAll('.', '%2E')

async function executeDisk(disk, { operation, kind, uuid, data } = {}, organizationId) {
    if (!disk || typeof disk.execute !== 'function') throw new TypeError('Tree Disk requires execute(operation)')
    const prefix = organizationId === undefined ? '' : organizationPath(organizationId)
    const scopedPath = path => prefix ? `${prefix}/${path}` : path
    if (operation === 'clear') return await disk.execute({ operation, kind: 'directory', ...(prefix ? { path: prefix } : {}) })
    if (operation === 'list') {
        const directories = { branch: 'branches', leaf: 'leaves' }
        const path = directories[kind]
        if (!path) throw new Error(`Unsupported disk kind: ${kind}`)
        const files = await disk.execute({ operation, kind: 'directory', path: scopedPath(path) })
        return files.filter(file => file.endsWith('.json')).map(file => {
            const id = file.slice(0, -5)
            return kind === 'leaf' ? decodeUuid(id) : id
        })
    }
    if (operation === 'has' && kind === 'config') return true
    if (operation === 'delete' && kind === 'config') throw new Error('Deleting disk config is unsupported')
    const path = kind === 'config'
        ? 'config.json'
        : kind === 'branch'
            ? `branches/${uuid}.json`
            : kind === 'leaf'
                ? `leaves/${encodeUuid(uuid)}.json`
                : undefined
    if (!path) throw new Error(`Unsupported disk kind: ${kind}`)
    return await disk.execute({ operation, kind: 'file', path: scopedPath(path), data })
}

/**
 * Standalone tree engine. Storage is injected; this module has no Node or
 * browser imports. CRUD/query planning can consume the branch and range APIs.
 */
export class Tree {
    static stop = Symbol.for('cocreate.db.tree.stop')

    static async clearDisk(disk) { return await executeDisk(disk, { operation: 'clear' }) }
    #database
    #manager
    #disk
    #pruneQueue = Promise.resolve()
    constructor() {
        this.#database = {
            config: {},
            leaves: new Map(),
            tree: new Map(),
            deleting: new Set(),
            readExternal: undefined
        }
        this.size = 1024
        this.leafSize = 1024
        this.organizationId = undefined
        this.#diskFirst = false
        this.roots = Object.freeze({
            get: path => this.#manager
                ? this.#manager.getRoots(path)
                : structuredClone(path ? getValueFromObject(this.#database.config.roots, path) : this.#database.config.roots),
            execute: ({ operation, path, data } = {}) => {
                if (!this.#manager) throw new Error('Tree must be initialized before updating roots')
                if (operation !== 'set') throw new TypeError(`Unsupported Tree roots operation: ${operation}`)
                return this.#manager.setRoots(path, data)
            }
        })
        this.branches = Object.freeze({ get: uuid => this.#getBranch(uuid) })
        this.leaves = Object.freeze({
            get: uuid => this.getLeaf(uuid),
            has: async uuid => this.#manager
                ? await this.#manager.hasLeaf(uuid)
                : await this.#database.leaves.has(uuid)
        })
    }

    async init(options = {}) {
        if (this.#manager) return this
        if (!isRecord(options) || !isRecord(options.roots))
            throw new TypeError('Tree.init requires a configuration with roots')
        const size = options.size ?? 1024
        this.size = size
        this.leafSize = options.leafSize ?? size
        const config = structuredClone(options)
        config.leaves ??= {}
        config.indexes ??= []
        this.#database = {
            config,
            leaves: new Map(),
            tree: new Map(),
            deleting: new Set(),
            readExternal: undefined
        }
        if (this.#disk && !this.#database.local) this.#attachDisk()
        this.#manager = await createRootManager({
            db: this.#database,
            size: this.size,
            leafSize: this.leafSize,
            persistConfig: async () => {
                const data = JSON.stringify(this.#database.config)
                const writes = []
                writes.push(this.#executeDisk({ operation: 'write', kind: 'config', data }))
                writes.push(this.persistence.execute({ operation: 'write', kind: 'config', data, ...(this.organizationId === undefined ? {} : { organization_id: this.organizationId }) }))
                await Promise.all(writes)
            },
            persist: operation => this.persistence.execute({ ...operation, ...(this.organizationId === undefined ? {} : { organization_id: this.organizationId }) }),
            shouldReleaseIndexed: () => this.diskFirst && !!this.#disk
        })
        this.#setExternalRead()
        if (this.#database.local) this.#database.local.resolveLeaf = async id => await this.#manager.getLeaf(id) ?? this.#database.deleted?.get(id)
        if (this.#database.leaves instanceof LeafTier) this.#database.leaves.pending = this.#manager.pendingIndex
        return this
    }

    #persistence

    get persistence() { return this.#persistence ?? emptyStorage }
    set persistence(resource) {
        if (resource !== undefined && resource !== null && typeof resource.execute !== 'function')
            throw new TypeError('Tree persistence must expose execute(operation)')
        this.#persistence = resource ?? undefined
        this.#setExternalRead()
    }

    #setExternalRead() {
        if (!this.#manager) return
        this.#manager.setReadExternal(typeof this.#persistence?.execute === 'function'
            ? uuid => this.#persistence.execute({ operation: 'read', kind: 'leaf', uuid, ...(this.organizationId === undefined ? {} : { organization_id: this.organizationId }) })
            : undefined)
    }

    get disk() { return this.#disk ?? emptyStorage }
    set disk(disk) {
        if (disk !== undefined && disk !== null && typeof disk.execute !== 'function')
            throw new TypeError('Tree disk must expose execute(operation)')
        this.#disk = disk ?? undefined
        if (this.#disk && this.#manager && !this.#database.local) this.#attachDisk()
    }

    async #executeDisk(operation) { return await executeDisk(this.disk, operation, this.organizationId) }

    #attachDisk() {
        const local = new LocalTier(operation => this.#executeDisk(operation), undefined, {
            resolveLeaf: async id => await this.#database.leaves.get?.(id) ?? this.#database.deleted?.get(id)
        })
        const leaves = new LeafTier(local)
        for (const [uuid, leaf] of this.#database.leaves) leaves.set(uuid, leaf)
        this.#database.local = local
        this.#database.leaves = leaves
        if (this.#manager) {
            leaves.pending = this.#manager.pendingIndex
            local.resolveLeaf = async id => await this.#manager.getLeaf(id) ?? this.#database.deleted?.get(id)
        }
    }

    #diskFirst

    get diskFirst() { return this.#diskFirst }

    /** Temporarily switch request handling to a disk-first lifecycle. */
    setDiskFirst(enabled) {
        if (enabled && !this.#disk) throw new Error('Disk-first mode requires a disk handler')
        this.#diskFirst = Boolean(enabled)
        return this.#diskFirst
    }

    get config() { return structuredClone(this.#database.config) }

    get pendingIndexCount() { return this.#manager.pendingIndex.size }

    /** Resolve the index-bearing branch for the configured root in a CRUD payload. */
    async getPrimaryBranch(payload = {}) {
        const target = String(payload.method ?? '').split('.')[0]
        if (!target) throw new Error('A CRUD method is required to resolve the primary branch')
        let resolved
        try { resolved = await this.#manager.resolve(payload, target) }
        catch (error) {
            if (!/Missing root reference|Ambiguous root path/.test(error.message)) throw error
            resolved = { target, path: undefined, parent: undefined, missing: false, incomplete: true }
        }
        const fields = []
        for (const [key, types] of this.#database.tree) {
            for (const [type, index] of types) {
                await index.initialize()
                const root = index.root
                fields.push({
                    key,
                    type,
                    uuid: root.uuid,
                    count: root.length,
                    min: root.firstValue,
                    max: root.lastValue,
                    firstUuid: root.firstUuid,
                    lastUuid: root.lastUuid,
                    branches: (root.branches ?? []).map(branch => index.reference(branch))
                })
            }
        }
        fields.sort((a, b) => a.key.localeCompare(b.key) || a.type.localeCompare(b.type))
        return {
            target,
            path: resolved.path,
            parent: resolved.parent && { uuid: resolved.parent.uuid, root: resolved.parent.root, name: resolved.parent.name },
            missing: resolved.missing,
            incomplete: resolved.incomplete ?? false,
            fields
        }
    }

    /** Resolve a concrete field/type index; selection/planning stays with callers. */
    #getIndex(key, type) { return this.#database.tree.get(key)?.get(type) }

    /** Resolve a branch UUID across the configured field/type indexes. */
    async #getBranch(uuid) {
        if (typeof uuid !== 'string' || !uuid) throw new TypeError('Branch UUID is required')
        for (const types of this.#database.tree.values()) {
            for (const index of types.values()) {
                const branch = await index.findUuidDeep(uuid)
                if (branch) return index.reference(branch)
            }
        }
        return undefined
    }

    /** Stream index entries in an inclusive value range without materializing them. */
    async *range(key, type, { min, max, branchUuid } = {}) {
        const index = this.#getIndex(key, type)
        if (!index) return
        const branch = branchUuid ? await index.findUuid(branchUuid) : index.root
        if (!branch) return
        yield* index.scan(min, max, branch)
    }

    /** Stream full leaves represented by an index range. */
    /** Read-only range stream. Use visitRange when the callback may mutate leaves. */
    async *rangeLeaves(key, type, range = {}) {
        for await (const entry of this.range(key, type, range)) {
            const leaf = await this.getLeaf(entry.uuid)
            if (leaf) yield leaf
        }
    }

    async visitRange(key, type, range, visit, { mutating = false } = {}) {
        return await this.#manager.visitRange(key, type, { ...range, mutating }, visit)
    }

    async visitRanges(key, type, ranges, visit, { mutating = false } = {}) {
        return await this.#manager.visitRanges(key, type, ranges, { mutating }, visit)
    }

    /** Visit every live leaf for an unindexed query or full scan. */
    async visitLeaves(visit, { mutating = false } = {}) {
        return await this.#manager.visitLeaves({ mutating }, visit)
    }

    async *getLeaves(plan) {
        yield* this.#manager.getLeaves(plan)
    }

    async getLeaf(uuid) { return await this.#manager.getLeaf(uuid) }

    setReadExternal(read) { this.#manager.setReadExternal(read) }

    /** Create a leaf under the configured root resolved by the supplied envelope. */
    async createLeaf(root, value, envelope = {}, { identityChecked = false } = {}) {
        const leaves = await this.createLeaves(root, [value], envelope, { identityChecked })
        return leaves[0]
    }

    async createLeaves(root, values, envelope = {}, { identityChecked = false } = {}) {
        if (!Array.isArray(values)) values = [values]
        if (values.some(value => !isRecord(value))) throw new TypeError('Tree leaf data must be an object')
        const resolved = await this.#manager.resolve(envelope, root, { createMissing: true })
        if (resolved.missing) return []
        return await this.#manager.createMany(values, resolved.parent, root, { identityChecked })
    }

    async matchesRoot(envelope, root, leaf) { return await this.#manager.matchesRoot(envelope, root, leaf) }

    async updateLeaf(uuid, patch) {
        const leaf = await this.#database.leaves.get(uuid)
        if (!leaf) return undefined
        return await updateLeaf(leaf, patch)
    }

    async removeLeaf(uuid) {
        const leaf = await this.#database.leaves.get(uuid)
        if (!leaf) return false
        return await this.#manager.remove(leaf)
    }

    /** Release one fully indexed leaf and its resident index branches, retaining disk files. */
    async evictLeaf(uuid) {
        const leaf = await this.#database.leaves.get(uuid)
        if (!leaf || typeof leaf.toDisk !== 'function') return false
        const indexes = new Set()
        for (const entry of Object.values(await leaf.getIndex())) if (entry?.index) indexes.add(entry.index)
        for (const index of indexes) await index.toDisk?.()
        return await leaf.toDisk()
    }

    /** Release eligible branch contents from memory, preserving tree paths. */
    prune(options = {}) {
        const configured = this.#database.config.prune ?? {}
        const strategy = options.strategy ?? configured.strategy ?? 'lfu'
        const limit = Object.hasOwn(options, 'limit') ? options.limit : configured.limit
        if (!['lfu', 'lru', 'noeviction'].includes(strategy))
            throw new TypeError(`Unsupported Tree pruning strategy: ${strategy}`)
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 0))
            throw new TypeError('Tree pruning limit must be a non-negative integer')
        if (strategy === 'noeviction' || limit === 0)
            return Promise.resolve({ strategy, target: 0, candidates: 0, count: 0, skipped: 0 })
        const task = this.#pruneQueue.then(async () => {
            if (this.#database.local) return await this.#database.local.prune({ strategy, limit })
            const candidates = []
            for (const types of this.#database.tree.values())
                for (const index of types.values()) candidates.push(...index.prunableBranches())
            candidates.sort(strategy === 'lru'
                ? (a, b) => a.lastVisited - b.lastVisited || a.weight - b.weight || a.uuid.localeCompare(b.uuid)
                : (a, b) => a.weight - b.weight || a.lastVisited - b.lastVisited || a.uuid.localeCompare(b.uuid))
            const target = Math.min(candidates.length, limit ?? candidates.length)
            let count = 0
            for (let i = 0; i < target; i++) {
                const branch = candidates[i]
                const weight = branch.weight
                const revision = branch.revision
                if (this.#persistence) {
                    const file = await branch.getFile()
                    await this.persistence.execute({ operation: 'write', kind: 'branch', uuid: branch.uuid, data: file.content })
                }
                if (branch.tree.pruneBranch(branch, { weight, revision })) count++
            }
            return { strategy, target, candidates: candidates.length, count, skipped: target - count }
        })
        this.#pruneQueue = task.catch(() => {})
        return task
    }

    async close() {
        await this.#manager?.close()
    }
}

export default Tree
