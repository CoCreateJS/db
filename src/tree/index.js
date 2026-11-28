import execute from './execute.js'
import planner from './planner.js'
import { treeContexts } from './internal.js'
import { LeafTier } from './leaves.js'
import { LocalTier } from './local-core.js'
import { createManager } from './manager.js'
import { updateLeaf } from './leaf.js'
import { executeDisk, emptyStorage, storageRequest } from '../disk.js'

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
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
            readExternal: undefined
        }
        this.uuid = undefined
        this.organizationId = undefined
        this.weight = 0
        this.active = 0
        this.#diskFirst = false
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

    #initializing
    init(options = {}) {
        return this.#initializing ??= this.#initialize(options)
    }

    async #initialize(options) {
        if (!isRecord(options) || !isRecord(options.roots))
            throw new TypeError('Tree.init requires a configuration with roots')
        const size = options.size ?? 1024
        this.#size = size
        this.#leafSize = options.leafSize ?? size
        this.uuid = options.uuid
        if (typeof this.uuid !== 'string' || !this.uuid) throw new TypeError('Tree.init requires a primary branch UUID')
        const stored = this.#disk ? await executeDisk(this, { operation: 'read', kind: 'config' }) : undefined
        const config = { ...(stored ? JSON.parse(stored) : {}), ...structuredClone(options) }
        config.indexes ??= []
        this.#database = {
            config,
            leaves: new Map(),
            tree: new Map(),
            readExternal: undefined
        }
        if ((this.#disk || this.#persistence) && !this.#database.local) this.#attachStorage()
        this.#manager = await createManager({
            db: this.#database,
            owner: this,
            size: this.#size,
            leafSize: this.#leafSize,
            onIdle: () => this.#onIndexed?.()
        })
        this.leaves = Object.freeze({
            get: async uuid => {
                const activity = this.#manager.operation()
                try { return await this.#manager.getLeaf(uuid) } finally { await activity.release() }
            },
            has: async uuid => Boolean(await this.leaves.get(uuid))
        })
        this.close = this.#manager.close
        const tree = this
        treeContexts.set(this, {
            leaves: { get: this.#manager.getLeaf, has: this.#manager.hasLeaf },
            branches: this.#branches,
            get canDrop() { return !!tree.#disk && !tree.active && !tree.#manager.pendingIndex.size && !tree.disk.queue[tree.uuid] && !tree.persistence.queue[tree.uuid] && !tree.#manager.storage.size },
            get diskFirst() { return tree.#diskFirst },
            get leafCount() { return tree.#database.leaves.size },
            referenceLeaf: uuid => Map.prototype.get.call(tree.#database.leaves, uuid) ?? tree.#database.deleted.get(uuid),
            set onIndexed(callback) { tree.#onIndexed = callback },
            operation: this.#manager.operation,
            configureRoots: this.#manager.configureRoots,
            hasRoot: this.#manager.hasRoot,
            get planner() { return tree.planner },
            get pendingIndexCount() { return tree.#manager.pendingIndex.size },
            get pendingDiskCount() { return tree.#manager.storage.size },
            getPrimaryBranch: this.#getPrimaryBranch.bind(this),
            range: this.#range.bind(this),
            rangeLeaves: this.#rangeLeaves.bind(this),
            visitRange: this.#manager.visitRange,
            visitRanges: this.#manager.visitRanges,
            visitLeaves: this.#manager.visitLeaves,
            getLeaves: this.#manager.getLeaves,
            getLeaf: this.#manager.getLeaf,
            setReadExternal: this.#manager.setReadExternal,
            createLeaf: this.#manager.create,
            createLeaves: this.#manager.createMany,
            matchesRoot: this.#manager.matchesRoot,
            updateLeaf: this.#updateLeaf.bind(this),
            removeLeaf: this.#removeLeaf.bind(this),
        })
        if (options.diskFirst) this.setDiskFirst(true)
        this.#setExternalRead()
        if (this.#database.local) this.#database.local.resolveLeaf = async id => await this.#manager.getLeaf(id) ?? this.#database.deleted?.get(id)
        return this
    }

    #persistence

    get persistence() { return this.#persistence ?? emptyStorage }
    set persistence(resource) {
        if (resource !== undefined && resource !== null && (typeof resource.execute !== 'function' || !resource.queue))
            throw new TypeError('Tree persistence must expose execute(operation) and queue')
        this.#persistence = resource ?? undefined
        if (this.#persistence && this.#manager && !this.#database.local) this.#attachStorage()
        this.#setExternalRead()
    }

    #setExternalRead() {
        if (!this.#manager) return
        this.#manager.setReadExternal(this.#persistence
            ? uuid => this.#persistence.execute(storageRequest(this, { operation: 'read', kind: 'leaf', uuid }))
            : undefined)
    }

    get disk() { return this.#disk ?? emptyStorage }
    set disk(disk) {
        if (disk !== undefined && disk !== null && (typeof disk.execute !== 'function' || !disk.queue))
            throw new TypeError('Tree disk must expose execute(operation) and queue')
        this.#disk = disk ?? undefined
        if (this.#disk && this.#manager && !this.#database.local) this.#attachStorage()
    }

    #attachStorage() {
        const local = new LocalTier(executeDisk.bind(null, this), undefined, {
            referenceLeaf: id => this.#database.leaves.reference(id) ?? this.#database.deleted?.get(id),
            resolveLeaf: async id => await this.#database.leaves.get(id) ?? this.#database.deleted?.get(id)
        })
        const previous = this.#database.leaves
        const leaves = new LeafTier(local)
        leaves.restore = previous.restore
        leaves.belongs = previous.belongs
        leaves.deleted = this.#database.deleted
        for (const [uuid, leaf] of previous) leaves.set(uuid, leaf)
        this.#database.local = local
        this.#database.leaves = leaves
        if (this.#manager) {
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
    async #getPrimaryBranch(payload = {}) {
        const target = String(payload.method ?? '').split('.')[0]
        if (!target) throw new Error('A CRUD method is required to resolve the primary branch')
        if (!Object.hasOwn(this.#database.config.roots, target)) throw new Error(`Root is not configured: ${target}`)
        return { target, parent: { uuid: this.uuid }, missing: false, fields: this.#manager.primaryIndexes() }
    }

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
    async *#range(key, type, { min, max, branchUuid } = {}) {
        const index = this.#database.tree.get(key)?.get(type)
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

    async persist() {
        if (!this.#persistence) return { success: false, skipped: true }
        if (typeof this.#persistence.persist !== 'function') return { success: true, skipped: true }
        return await this.#persistence.persist()
    }

}

export default Tree
