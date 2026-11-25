import { DiskBranch, restoreIndexEntry } from './leaf.js'
import { Weights } from './weights.js'
import { requestDisk } from '../disk/index.js'

export class LocalTier {
    constructor(disk, resolve, { resolveLeaf } = {}) {
        this.disk = disk
        this.resolve = resolve
        this.resolveLeaf = resolveLeaf
        this.weights = new Weights()
        this.buckets = this.weights
        this.active = new Set()
        this.dirty = new Set()
        this.pendingDiscards = new Set()
        this.reads = 0
        this.writes = 0
    }

    async initialize() { await requestDisk(this.disk, 'disk.initialize'); return this }

    get warmBranches() {
        const local = this
        return {
            get size() { return local.listBranches().then(items => items.length) },
            has(id) { return requestDisk(local.disk, 'disk.has', { kind: 'branch', uuid: id }) },
            keys() { return (async function* () { yield* await local.listBranches() })() }
        }
    }

    async listBranches() { return await requestDisk(this.disk, 'disk.list', { kind: 'branch' }) }
    async deleteLeaf(id) { return await requestDisk(this.disk, 'disk.delete', { kind: 'leaf', uuid: id }) }
    add(index) { this.pendingDiscards.delete(index.uuid); this.weights.add(index) }
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
            await requestDisk(this.disk, 'disk.write', { kind: 'branch', uuid: index.uuid, data: file.content })
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
        await requestDisk(this.disk, 'disk.write', { kind: 'branch', uuid: index.uuid, data: file.content })
        this.pendingDiscards.delete(index.uuid)
        this.dirty.delete(index)
        this.writes++
    }

    async persistDiscards() {
        let count = 0
        for (const id of this.pendingDiscards) {
            await requestDisk(this.disk, 'disk.delete', { kind: 'branch', uuid: id })
            this.pendingDiscards.delete(id)
            count++
        }
        return count
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
        if (this.pendingDiscards.has(id)) return undefined
        const content = await requestDisk(this.disk, 'disk.read', { kind: 'branch', uuid: id })
        this.reads++
        return JSON.parse(content)
    }

    async discard(index) {
        this.remove(index)
        this.dirty.delete(index)
        if (index.onDisk) {
            this.pendingDiscards.add(index.uuid)
            index.onDisk = false
        }
    }
}

export default LocalTier
