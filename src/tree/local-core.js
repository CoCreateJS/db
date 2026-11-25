import { DiskBranch, restoreIndexEntry } from './leaf.js'
import { Weights } from './weights.js'
export class LocalTier {
    constructor(disk, resolve, { resolveLeaf, persistBranch } = {}) {
        this.disk = disk
        this.resolve = resolve
        this.resolveLeaf = resolveLeaf
        this.persistBranch = persistBranch
        this.weights = new Weights('weight')
        this.buckets = this.weights
        this.active = new Set()
        this.dirty = new Set()
        this.pendingDiscards = new Set()
        this.reads = 0
        this.writes = 0
    }

    get warmBranches() {
        const local = this
        return {
            get size() { return local.listBranches().then(items => items.length) },
            has(id) { return local.disk({ operation: 'has', kind: 'branch', uuid: id }) },
            keys() { return (async function* () { yield* await local.listBranches() })() }
        }
    }

    async listBranches() { return await this.disk({ operation: 'list', kind: 'branch' }) }
    async deleteLeaf(id) { return await this.disk({ operation: 'delete', kind: 'leaf', uuid: id }) }
    add(index) { this.pendingDiscards.delete(index.uuid); this.weights.add(index) }
    remove(index) { this.weights.remove(index) }
    touch(index) { this.weights.touch(index) }

    prune({ strategy = 'lfu', limit } = {}) {
        const eligible = index => !!index.entries && !index.branches && !this.active.has(index)
        const evict = index => this.evictOne(index)
        if (strategy === 'noeviction' || limit === 0)
            return Promise.resolve({ strategy, target: 0, candidates: 0, count: 0, skipped: 0 })
        if (this.eviction) return this.eviction
        const job = strategy === 'lfu'
            ? this.weights.evictBatch(limit ?? Infinity, eligible, evict)
            : this.evictLru(limit, eligible, evict)
        this.eviction = Promise.resolve(job).then(result => ({ strategy, ...result })).finally(() => { this.eviction = null })
        return this.eviction
    }

    async evictLru(limit, eligible, evict) {
        const selected = []
        for (const [, indexes] of this.weights)
            for (const index of indexes) if (eligible(index)) selected.push(index)
        selected.sort((a, b) => a.lastVisited - b.lastVisited || a.weight - b.weight || a.uuid.localeCompare(b.uuid))
        const candidates = selected.length
        selected.length = Math.min(candidates, limit ?? candidates)
        const ranked = selected.map(object => ({ object, weight: object.weight }))
        return { target: ranked.length, candidates, ...await this.weights.evictSelected(ranked, eligible, evict, 4) }
    }

    async evictOne(index) {
        if (this.active.has(index) || !index.entries || index.branches || !this.weights.has(index)) return false
        const weight = index.weight
        const revision = index.revision
        this.active.add(index)
        try {
            const file = await index.getFile()
            await this.disk({ operation: 'write', kind: 'branch', uuid: index.uuid, data: file.content })
            await this.persistBranch?.({ operation: 'write', kind: 'branch', uuid: index.uuid, data: file.content })
            if (index.weight !== weight || index.revision !== revision || !index.entries || index.branches || !this.weights.has(index) || !this.canRelease(index)) return false
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
            await this.disk({ operation: 'write', kind: 'branch', uuid: index.uuid, data: file.content })
        this.pendingDiscards.delete(index.uuid)
        this.dirty.delete(index)
        this.writes++
    }

    async persistDiscards() {
        let count = 0
        for (const id of this.pendingDiscards) {
            await this.disk({ operation: 'delete', kind: 'branch', uuid: id })
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
        const content = await this.disk({ operation: 'read', kind: 'branch', uuid: id })
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
