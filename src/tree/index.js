import execute from './execute.js'
import planner from './planner.js'
import { treeContexts } from './internal.js'
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

async function executeDisk(tree, { operation, kind, uuid, data }) {
    const disk = tree.disk
    const organizationId = tree.organizationId
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
    #database
    #manager
    #disk
    #branches
    #size = 1024
    #leafSize = 1024
    #onIndexed
    constructor() {
        this.#database = {
            config: {},
            leaves: new Map(),
            tree: new Map(),
            deleting: new Set(),
            readExternal: undefined
        }
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
        this.#branches = Object.freeze({ get: this.#getBranch.bind(this) })
        this.leaves = Object.freeze({
            get: uuid => this.#manager.getLeaf(uuid),
            has: async uuid => this.#manager
                ? await this.#manager.hasLeaf(uuid)
                : await this.#database.leaves.has(uuid)
        })
        this.execute = execute
        this.planner = planner
    }

    async init(options = {}) {
        if (this.#manager) return this
        if (!isRecord(options) || !isRecord(options.roots))
            throw new TypeError('Tree.init requires a configuration with roots')
        const size = options.size ?? 1024
        this.#size = size
        this.#leafSize = options.leafSize ?? size
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
            size: this.#size,
            leafSize: this.#leafSize,
            persistConfig: async () => {
                const data = JSON.stringify(this.#database.config)
                await Promise.all([
                    executeDisk(this, { operation: 'write', kind: 'config', data }),
                    this.persistence.execute({ operation: 'write', kind: 'config', data, ...(this.organizationId === undefined ? {} : { organization_id: this.organizationId }) })
                ])
            },
            persist: operation => this.persistence.execute({ ...operation, ...(this.organizationId === undefined ? {} : { organization_id: this.organizationId }) }),
            onIdle: async () => {
                if (this.#diskFirst) await this.prune()
                this.#onIndexed?.()
            },
            canPrune: () => !!this.#disk
        })
        this.leaves = Object.freeze({ get: this.#manager.getLeaf, has: this.#manager.hasLeaf })
        this.roots = Object.freeze({ get: this.#manager.getRoots, execute: this.roots.execute })
        this.close = this.#manager.close
        const tree = this
        treeContexts.set(this, {
            leaves: this.leaves,
            branches: this.#branches,
            get pruneCandidates() { return tree.#manager.pruneCandidates() },
            set onIndexed(callback) { tree.#onIndexed = callback },
            operation: this.#manager.operation,
            get planner() { return tree.planner },
            get pendingIndexCount() { return tree.#manager.pendingIndex.size },
            getPrimaryBranch: this.#getPrimaryBranch.bind(this),
            range: this.#range.bind(this),
            rangeLeaves: this.#rangeLeaves.bind(this),
            visitRange: this.#visitRange.bind(this),
            visitRanges: this.#visitRanges.bind(this),
            visitLeaves: this.#visitLeaves.bind(this),
            getLeaves: this.#manager.getLeaves,
            getLeaf: this.#manager.getLeaf,
            setReadExternal: this.#manager.setReadExternal,
            createLeaf: this.#createLeaf.bind(this),
            createLeaves: this.#createLeaves.bind(this),
            matchesRoot: this.#manager.matchesRoot,
            updateLeaf: this.#updateLeaf.bind(this),
            removeLeaf: this.#removeLeaf.bind(this),
        })
        if (options.diskFirst) this.setDiskFirst(true)
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
        this.#manager.setReadExternal(this.#persistence
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

    #attachDisk() {
        const local = new LocalTier(executeDisk.bind(null, this), undefined, {
            referenceLeaf: id => this.#database.leaves.reference(id) ?? this.#database.deleted?.get(id),
            resolveLeaf: async id => await this.#database.leaves.get(id) ?? this.#database.deleted?.get(id)
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

    /** Temporarily switch request handling to a disk-first lifecycle. */
    setDiskFirst(enabled) {
        if (enabled && !this.#disk) throw new Error('Disk-first mode requires a disk handler')
        this.#diskFirst = Boolean(enabled)
        return this.#diskFirst
    }

    get config() { return structuredClone({ ...this.#database.config, size: this.#size, leafSize: this.#leafSize, diskFirst: this.#diskFirst }) }

    /** Resolve the index-bearing branch for the configured root in a CRUD payload. */
    async #getPrimaryBranch(payload = {}, operation) {
        const target = String(payload.method ?? '').split('.')[0]
        if (!target) throw new Error('A CRUD method is required to resolve the primary branch')
        let resolved
        try { resolved = await this.#manager.resolve(payload, target, { operation }) }
        catch (error) {
            if (!/Missing root reference|Ambiguous root path/.test(error.message)) throw error
            resolved = { target, path: undefined, parent: undefined, missing: false, incomplete: true }
        }
        const fields = this.#manager.primaryIndexes(resolved.parent?.uuid, payload)
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
    #getIndex(key, type) { return [...this.#database.tree.values()].map(fields => fields.get(key)?.get(type)).find(Boolean) }

    /** Resolve a branch UUID across the configured field/type indexes. */
    async #getBranch(uuid) {
        if (typeof uuid !== 'string' || !uuid) throw new TypeError('Branch UUID is required')
        for (const fields of this.#database.tree.values()) for (const types of fields.values()) {
            for (const index of types.values()) {
                const branch = await index.findUuidDeep(uuid)
                if (branch) return index.reference(branch)
            }
        }
        return undefined
    }

    /** Stream index entries in an inclusive value range without materializing them. */
    async *#range(key, type, { min, max, branchUuid } = {}) {
        const index = this.#getIndex(key, type)
        if (!index) return
        const branch = branchUuid ? await index.findUuid(branchUuid) : index.root
        if (!branch) return
        yield* index.scan(min, max, branch)
    }

    /** Stream full leaves represented by an index range. */
    /** Read-only range stream. Use visitRange when the callback may mutate leaves. */
    async *#rangeLeaves(key, type, range = {}) {
        for await (const entry of this.#range(key, type, range)) {
            const leaf = await this.#manager.getLeaf(entry.uuid)
            if (leaf) yield leaf
        }
    }

    async #visitRange(key, type, range, visit, { mutating = false } = {}) {
        return await this.#manager.visitRange(key, type, { ...range, mutating }, visit)
    }

    async #visitRanges(key, type, ranges, visit, { mutating = false } = {}) {
        return await this.#manager.visitRanges(key, type, ranges, { mutating }, visit)
    }

    /** Visit every live leaf for an unindexed query or full scan. */
    async #visitLeaves(visit, { mutating = false } = {}) {
        return await this.#manager.visitLeaves({ mutating }, visit)
    }

    /** Create a leaf under the configured root resolved by the supplied envelope. */
    async #createLeaf(root, value, envelope = {}, { identityChecked = false, operation } = {}) {
        const leaves = await this.#createLeaves(root, [value], envelope, { identityChecked, operation })
        return leaves[0]
    }

    async #createLeaves(root, values, envelope = {}, { identityChecked = false, operation } = {}) {
        const resolved = await this.#manager.resolve(envelope, root, { createMissing: true, operation })
        if (resolved.missing) return []
        return await this.#manager.createMany(values, resolved.parent, root, { identityChecked })
    }

    async #updateLeaf(uuid, patch) {
        const leaf = await this.#database.leaves.get(uuid)
        if (!leaf) return undefined
        return await updateLeaf(leaf, patch)
    }

    async #removeLeaf(uuid) {
        const leaf = await this.#database.leaves.get(uuid)
        if (!leaf) return false
        return await this.#manager.remove(leaf)
    }

    /** Evict complete primary groups, lowest weight first; stored files remain intact. */
    async prune({ uuid, limit = Infinity } = {}) {
        if (limit !== Infinity && (!Number.isInteger(limit) || limit < 0))
            throw new TypeError('Tree pruning limit must be a non-negative integer')
        if (limit === 0) return { count: 0 }
        if (uuid !== undefined) return { count: Number(this.#manager.prunePrimary(uuid)) }
        const candidates = this.#manager.pruneCandidates().sort((a, b) => a.weight - b.weight || a.uuid.localeCompare(b.uuid))
        let count = 0
        for (const group of candidates) {
            if (count >= limit) break
            if (this.#manager.prunePrimary(group.uuid)) count++
        }
        return { count }
    }

    async persist() {
        if (!this.#persistence) return { success: false, skipped: true }
        if (typeof this.#persistence.persist !== 'function') return { success: true, skipped: true }
        return await this.#persistence.persist()
    }

}

export default Tree
