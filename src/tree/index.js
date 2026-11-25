import { LeafTier } from './leaves.js'
import { LocalTier } from './local-core.js'
import { createConfiguration, createRootManager } from './manager.js'
import { updateLeaf } from './leaf.js'
import { requestDisk } from '../disk/index.js'

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * Standalone tree engine. Storage is injected; this module has no Node or
 * browser imports. CRUD/query planning can consume the branch and range APIs.
 */
export class Tree {
    static stop = Symbol.for('cocreate.db.tree.stop')

    #database
    #manager
    #shedQueue = Promise.resolve()
    static async create({ config, roots, disk, read, diskInitialized = false, size = 1024, leafSize = size, deferIndex = true, persist } = {}) {
        const configuration = createConfiguration({ config, roots })
        const database = {
            config: configuration,
            leaves: new Map(),
            tree: new Map(),
            deleting: new Set(),
            readExternal: read
        }
        const tree = new Tree(database, { size, leafSize, deferIndex, disk, persist })
        if (disk) {
            if (!diskInitialized) await requestDisk(envelope => tree.disk(envelope), 'disk.initialize')
            const local = new LocalTier(envelope => tree.disk(envelope), undefined, { resolveLeaf: async id => await database.leaves.get?.(id) ?? database.deleted?.get(id) })
            database.local = local
            database.leaves = new LeafTier(local)
        }
        tree.#manager = await createRootManager({
            db: database,
            size,
            leafSize,
            deferIndex,
            persistConfig: async () => {
                if (tree.disk) await requestDisk(envelope => tree.disk(envelope), 'disk.write', { kind: 'config', data: JSON.stringify(database.config) })
            },
            persist: async envelope => await tree.persist(envelope)
        })
        if (database.local) database.local.resolveLeaf = async id => await tree.#manager.getLeaf(id) ?? database.deleted?.get(id)
        if (database.leaves instanceof LeafTier) database.leaves.pending = tree.#manager.pendingIndex
        tree.leaves = Object.freeze({
            get: uuid => tree.getLeaf(uuid),
            set: (root, values, envelope = {}, options = {}) => tree.createLeaves(root, values, envelope, options)
        })
        return tree
    }

    constructor(database, options = {}) {
        this.#database = database
        this.size = options.size ?? 1024
        this.leafSize = options.leafSize ?? this.size
        this.deferIndex = options.deferIndex ?? true
        this.disk = options.disk
        this.persist = options.persist ?? (async () => ({ success: true }))
        this.#diskFirst = false
    }

    #diskFirst

    get diskFirst() { return this.#diskFirst }

    /** Temporarily switch request handling to a disk-first lifecycle. */
    setDiskFirst(enabled) {
        if (enabled && !this.disk) throw new Error('Disk-first mode requires a disk handler')
        this.#diskFirst = Boolean(enabled)
        return this.#diskFirst
    }

    get config() { return structuredClone(this.#database.config) }

    get pendingIndexCount() { return this.#manager.pendingIndex.size }

    /** Return index summaries, optionally bound to a configured root path. */
    async getRootBranch(envelope, target, { createMissing = false, allowPartial = false } = {}) {
        let resolved
        if (target !== undefined) {
            try { resolved = await this.#manager.resolve(envelope ?? {}, target, { createMissing }) }
            catch (error) {
                if (!allowPartial || createMissing || !/Missing root reference|Ambiguous root path/.test(error.message)) throw error
                resolved = { target, path: undefined, parent: undefined, missing: false, incomplete: true }
            }
        }
        await this.flushIndex()
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
        if (target === undefined) return fields
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

    /** Resolve a branch by UUID within one field/type index. */
    async getBranch(key, type, uuid) {
        await this.flushIndex()
        const index = this.#getIndex(key, type)
        const branch = index ? await index.findUuid(uuid) : undefined
        return branch ? index.reference(branch) : undefined
    }

    /** Stream index entries in an inclusive value range without materializing them. */
    async *range(key, type, { min, max, branchUuid } = {}) {
        await this.flushIndex()
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

    async flushIndex() { return await this.#manager.flushIndex() }

    /** Evict one complete lowest-weight group from each resident tier. */
    shed() {
        const task = this.#shedQueue.then(async () => {
            await this.flushIndex()
            if (!this.disk) throw new Error('Tree shedding requires a disk handler')
            const branches = await this.#database.local?.evictLowestWeight() ?? { count: 0, weight: null }
            const leaves = await this.#database.leaves.evictLowestWeight?.() ?? { count: 0, weight: null }
            return {
                branches: { count: branches.count, weight: branches.weight ?? null },
                leaves: { count: leaves.count, weight: leaves.weight ?? null },
                count: branches.count + leaves.count
            }
        })
        this.#shedQueue = task.catch(() => {})
        return task
    }

    /**
     * Persist changed leaves first, then reconcile and persist derived indexes.
     * External persistence is intentionally outside this Tree contract.
     */
    async flushLocal() {
        await this.#database.leaves.persistDeletes?.()
        await this.#database.leaves.persistDirty?.()
        await this.flushIndex()
        await this.#database.local?.persistDiscards()
        await this.#database.leaves.persistDeletes?.()
        await this.#database.leaves.persistDirty?.()
        await this.#database.local?.persistDirty()
        this.#manager.syncIndexCatalog()
        if (this.disk) await requestDisk(envelope => this.disk(envelope), 'disk.write', { kind: 'config', data: JSON.stringify(this.#database.config) })
    }
}

export async function createTree(options) { return await Tree.create(options) }

export { createConfiguration, defaultConfiguration } from './manager.js'

export default Tree
