import { Weights } from './weights.js'
import { bindLeafTier, createLeaf, residentIndexEntries } from './leaf.js'
import { requestDisk } from '../disk/index.js'

const residentHas = (tier, id) => Map.prototype.has.call(tier, id)

export class LeafTier extends Map {
    constructor(local) {
        super()
        this.local = local
        this.disk = local.disk
        this.weights = new Weights()
        this.buckets = this.weights
        this.refs = new WeakMap()
        this.dirty = new Map()
        this.pendingDeletes = new Set()
        this.writeLocks = new Map()
        this.reads = 0
        this.writes = 0
    }

    files() { return requestDisk(this.disk, 'disk.list', { kind: 'leaf' }) }

    get warm() {
        const tier = this
        return {
            get size() { return tier.files().then(files => files.length) },
            has(id) { return requestDisk(tier.disk, 'disk.has', { kind: 'leaf', uuid: id }) },
            keys() { return (async function* () { yield* await tier.files() })() }
        }
    }

    add(record) { this.weights.add(record) }
    remove(record) { this.weights.remove(record) }
    markDirty(object) { this.dirty.set(object.uuid, object) }

    withWriteLock(id, operation) {
        const previous = this.writeLocks.get(id) ?? Promise.resolve()
        const task = previous.catch(() => {}).then(operation)
        this.writeLocks.set(id, task)
        return task.finally(() => { if (this.writeLocks.get(id) === task) this.writeLocks.delete(id) })
    }

    async deleteFile(id) { return await this.withWriteLock(id, () => requestDisk(this.disk, 'disk.delete', { kind: 'leaf', uuid: id })) }
    touch(record) { if (record.object && !record.evicted) this.weights.touch(record) }

    set(id, object) {
        this.pendingDeletes.delete(id)
        super.set(id, object)
        if (object.root === 'object') {
            let record = this.refs.get(object)
            if (!record) {
                record = { id, object, viewed: 0, tier: this }
                this.refs.set(object, record)
                bindLeafTier(object, record)
            }
            record.object = object
            this.add(record)
        }
        return this
    }

    reserve(id, object) {
        this.set(id, object)
        const record = this.refs.get(object)
        if (record) record.active = true
        return object
    }

    release(object) {
        const record = object && this.refs.get(object)
        if (record) record.active = false
        return object
    }

    async has(id) {
        if (typeof id !== 'string') return false
        if (this.pendingDeletes.has(id)) return false
        if (super.has(id)) return true
        return await requestDisk(this.disk, 'disk.has', { kind: 'leaf', uuid: id })
    }

    async get(id) {
        if (typeof id !== 'string' || !id) return undefined
        if (this.pendingDeletes.has(id)) return undefined
        let object = super.get(id)
        if (!object) {
            let source
            try { source = await requestDisk(this.disk, 'disk.read', { kind: 'leaf', uuid: id }) }
            catch (error) { if (error.code === 'ENOENT' || error.name === 'NotFoundError') return undefined; throw error }
            if (source === undefined || source === null) return undefined
            const data = JSON.parse(source)
            object = (await this.restore?.(data, id)) ?? createLeaf(data.object, data.object.root !== 'object')
            if (!residentHas(this, id)) this.set(id, object)
            this.reads++
            object = super.get(id) ?? object
        }
        const record = object && this.refs.get(object)
        if (record) this.touch(record)
        return object
    }

    reference(id) { return super.get(id) }

    delete(id) {
        if (typeof id !== 'string' || !id) return super.delete(id)
        const object = super.get(id), record = object && this.refs.get(object)
        this.pendingDeletes.add(id)
        this.dirty.delete(id)
        if (record) { this.remove(record); record.object = null }
        return super.delete(id)
    }

    async persistDeletes() {
        let count = 0
        for (const id of [...this.pendingDeletes]) {
            if (await this.withWriteLock(id, async () => {
                if (!this.pendingDeletes.has(id)) return false
                await requestDisk(this.disk, 'disk.delete', { kind: 'leaf', uuid: id })
                this.pendingDeletes.delete(id)
                return true
            })) count++
        }
        return count
    }

    get totalSize() { return this.count() }

    async count() {
        let total = this.size
        for (const id of await this.files()) if (!residentHas(this, id) && !this.pendingDeletes.has(id)) total++
        return total
    }

    async persistAll() {
        let count = 0
        for (const [id, object] of super.entries()) {
            if (typeof object?.getFile !== 'function') continue
            if (await this.withWriteLock(id, async () => {
                if (super.get(id) !== object) return false
                try {
                    await requestDisk(this.disk, 'disk.write', { kind: 'leaf', uuid: id, data: (await object.getFile()).content })
                    if (super.get(id) !== object) return false
                    this.dirty.delete(id)
                    this.writes++
                    return true
                } catch (error) { throw error }
            })) count++
        }
        return count
    }

    async persistDirty() {
        let count = 0
        for (const [id, object] of this.dirty) {
            if (await this.withWriteLock(id, async () => {
                if (super.get(id) !== object || this.dirty.get(id) !== object) return false
                await requestDisk(this.disk, 'disk.write', { kind: 'leaf', uuid: id, data: (await object.getFile()).content })
                if (super.get(id) !== object || this.dirty.get(id) !== object) return false
                this.dirty.delete(id)
                this.writes++
                return true
            })) count++
        }
        return count
    }

    async *references() {
        yield* Map.prototype.values.call(this)
        for (const id of await this.files()) {
            if (residentHas(this, id) || this.pendingDeletes.has(id)) continue
            const data = JSON.parse(await requestDisk(this.disk, 'disk.read', { kind: 'leaf', uuid: id }))
            if (data?.object) yield data.object
        }
    }

    async *values() {
        yield* Map.prototype.values.call(this)
        for (const id of await this.files()) {
            if (residentHas(this, id) || this.pendingDeletes.has(id)) continue
            const object = await this.get(id)
            if (object) yield object
        }
    }

    hydrate(record) {
        if (!record.evicted) return record.object
        return this.hydrateAsync(record)
    }

    async hydrateAsync(record) {
        const object = record.object
        const current = super.get(record.id)
        if (current && current !== object) return current
        const data = JSON.parse(await requestDisk(this.disk, 'disk.read', { kind: 'leaf', uuid: record.id }))
        for (const key of Object.keys(data.object)) {
            if (Object.getOwnPropertyDescriptor(object, key)?.configurable === false) continue
            Object.defineProperty(object, key, { value: data.object[key], writable: true, enumerable: true, configurable: true })
        }
        record.evicted = false
        super.set(record.id, object)
        this.add(record)
        this.reads++
        return object
    }

    async evictOne(record) {
        const object = record.object
        if (!object || record.evicted || !this.weights.has(record) || this.pending?.has(object) || record.active) return false
        record.active = true
        try {
            return await this.withWriteLock(record.id, async () => {
                if (record.object !== object || record.evicted || this.pending?.has(object)) return false
                const weight = record.viewed
                const content = (await object.getFile()).content
                await requestDisk(this.disk, 'disk.write', { kind: 'leaf', uuid: record.id, data: content })
                if (record.object !== object || record.viewed !== weight || this.pending?.has(object) || (await object.getFile()).content !== content) return false
                this.dirty.delete(record.id)
                this.writes++
                for (const entry of residentIndexEntries(object)) entry.releaseObject()
                this.remove(record)
                super.delete(record.id)
                record.evicted = true
                return true
            })
        } finally { record.active = false }
    }

    evictBatch(limit, options) {
        return this.weights.evictBatch(limit, record => !!record.object && !record.evicted && !record.active && !this.pending?.has(record.object), record => this.evictOne(record), options)
    }

    evictLowestWeight() {
        return this.weights.evictLowestWeight(record => !!record.object && !record.evicted && !record.active && !this.pending?.has(record.object), record => this.evictOne(record))
    }

    evict(fraction) {
        return this.weights.evict(fraction, record => !!record.object && !record.evicted && !record.active && !this.pending?.has(record.object), record => this.evictOne(record))
    }
}

export default LeafTier
