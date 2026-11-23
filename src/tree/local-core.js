import { DiskBranch, restoreIndexEntry } from '../leaf.js'
import { Weights } from './weights.js'

export class LocalTier {
    constructor(storage, resolve, { resolveLeaf } = {}) {
        this.storage = storage
        this.directory = storage.directory
        this.branchDirectory = storage.branchDirectory
        this.leafDirectory = storage.leafDirectory
        this.resolve = resolve
        this.resolveLeaf = resolveLeaf
        this.weights = new Weights()
        this.buckets = this.weights
        this.active = new Set()
        this.dirty = new Set()
        this.reads = 0
        this.writes = 0
    }

    async initialize() { await this.storage.initialize(); return this }

    get warmBranches() {
        const local = this
        return {
            get size() {
                if (typeof local.storage.listBranchesSync === 'function') return local.storage.listBranchesSync().length
                return local.storage.listBranches().then(items => items.length)
            },
            has(id) {
                if (typeof local.storage.hasBranchSync === 'function') return local.storage.hasBranchSync(id)
                return local.storage.hasBranch(id)
            },
            keys() {
                if (typeof local.storage.listBranchesSync === 'function') return local.storage.listBranchesSync()[Symbol.iterator]()
                return (async function* () { yield* await local.storage.listBranches() })()
            }
        }
    }

    branchPath(index) { return this.storage.branchPath?.(index.uuid) }
    leafPath(id) { return this.storage.leafPath?.(id) }
    async deleteLeaf(id) { return await this.storage.deleteLeaf(id) }
    add(index) { this.weights.add(index) }
    remove(index) { this.weights.remove(index) }
    touch(index) { this.weights.touch(index) }

    async evict(limit = Infinity, maxWeight = Infinity) {
        let count = 0
        for (const weight of this.buckets.keys()) {
            if (weight > maxWeight) break
            for (const index of this.buckets.get(weight) ?? []) {
                if (count >= limit) return count
                if (await index.toDisk()) count++
            }
        }
        return count
    }

    evictAsync(maxWeight = Infinity, fraction = 1) {
        if (this.eviction) return this.eviction
        this.eviction = this.drain(maxWeight, fraction).finally(() => { this.eviction = null })
        return this.eviction
    }

    evictLowestWeight() {
        if (this.eviction) return this.eviction
        this.eviction = this.weights.evictLowestWeight(
            index => !!index.entries && !index.branches && !this.active.has(index),
            index => this.evictOne(index)
        ).finally(() => { this.eviction = null })
        return this.eviction
    }

    drain(maxWeight, fraction) {
        return this.weights.evict(
            fraction,
            index => !!index.entries && !index.branches && !this.active.has(index),
            index => this.evictOne(index),
            maxWeight
        )
    }

    async evictOne(index) {
        if (this.active.has(index) || !index.entries || index.branches || !this.weights.has(index)) return false
        const weight = index.viewed
        const revision = index.revision
        this.active.add(index)
        try {
            const file = await index.getFile()
            await this.storage.writeBranch(index.uuid, file.content)
            if (index.viewed !== weight || index.revision !== revision || !index.entries || index.branches || !this.weights.has(index) || !this.canRelease(index)) return false
            this.dirty.delete(index)
            this.writes++
            this.release(index)
            return true
        } finally {
            this.active.delete(index)
        }
    }

    canRelease(index) {
        return !this.resolveLeaf || index.entries.every(([, entries]) => entries.every(entry => entry.canDetach()))
    }

    release(index) {
        this.remove(index)
        const parent = index.parent
        index.parentUuid = parent?.uuid ?? index.parentUuid ?? null
        index.previousUuid = index.neighborUuid(-1) ?? index.previousUuid ?? null
        index.nextUuid = index.neighborUuid(1) ?? index.nextUuid ?? null
        if (parent?.branches) {
            const at = parent.branches.indexOf(index)
            if (at >= 0) parent.branches[at] = index.reference()
        }
        index.parent = null
        if (this.resolveLeaf) {
            const disk = new DiskBranch(this, index)
            for (const [, entries] of index.entries)
                for (const entry of entries) entry.detach(disk)
        }
        delete index.entries
        index.onDisk = true
    }

    async restore(id, index, value) {
        if (this.resolveLeaf) return restoreIndexEntry(await this.resolveLeaf(id), index, value, id)
        return this.resolve(id, index.tree.key)
    }

    async write(index) {
        const file = await index.getFile()
        await this.storage.writeBranch(index.uuid, file.content)
        this.dirty.delete(index)
        this.writes++
    }

    async persistDirty() {
        let count = 0
        for (const index of [...this.dirty]) if (this.weights.has(index)) { await this.write(index); count++ }
        return count
    }

    async persistAll() {
        let count = 0
        for (const [, indexes] of this.weights) for (const index of indexes) { await this.write(index); count++ }
        return count
    }

    async read(index) { return await this.readByUuid(index.uuid) }

    async readByUuid(id) {
        const content = await this.storage.readBranch(id)
        this.reads++
        return JSON.parse(content)
    }

    async discard(index) {
        this.remove(index)
        this.dirty.delete(index)
        if (index.onDisk) {
            await this.storage.deleteBranch(index.uuid)
            index.onDisk = false
        }
    }
}

export default LocalTier
