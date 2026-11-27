import { bindLeafTier, createLeaf, residentIndexEntries } from './leaf.js'

const residentHas = (tier, id) => Map.prototype.has.call(tier, id)

export class LeafTier extends Map {
    constructor(local) {
        super()
        this.local = local
        this.disk = local.disk
        this.refs = new WeakMap()
        this.dirty = new Map()
        this.pendingDeletes = new Set()
        this.writeLocks = new Map()
        this.reads = 0
        this.writes = 0
    }

    files() { return this.disk({ operation: 'list', kind: 'leaf' }) }

    get warm() {
        const tier = this
        return {
            get size() { return tier.files().then(files => files.length) },
            has(id) { return tier.disk({ operation: 'has', kind: 'leaf', uuid: id }) },
            keys() { return (async function* () { yield* await tier.files() })() }
        }
    }

    markDirty(object) { this.dirty.set(object.uuid, object) }

    withWriteLock(id, operation) {
        const previous = this.writeLocks.get(id) ?? Promise.resolve()
        const task = previous.catch(() => {}).then(operation)
        this.writeLocks.set(id, task)
        return task.finally(() => { if (this.writeLocks.get(id) === task) this.writeLocks.delete(id) })
    }

    async deleteFile(id) { return await this.withWriteLock(id, () => this.disk({ operation: 'delete', kind: 'leaf', uuid: id })) }

    set(id, object) {
        this.pendingDeletes.delete(id)
        super.set(id, object)
        if (object.root === 'object') {
            let record = this.refs.get(object)
            if (!record) {
                record = { id, object, tier: this }
                this.refs.set(object, record)
                bindLeafTier(object, record)
            }
            record.object = object
        }
        return this
    }

    async has(id) {
        if (typeof id !== 'string') return false
        if (this.pendingDeletes.has(id)) return false
        if (super.has(id)) return true
        return await this.disk({ operation: 'has', kind: 'leaf', uuid: id })
    }

    async get(id, operation) {
        if (typeof id !== 'string' || !id) return undefined
        if (this.pendingDeletes.has(id)) return undefined
        let object = super.get(id)
        if (object) operation?.pin(object.parent ?? object.uuid)
        if (!object) {
            let source
            try { source = await this.disk({ operation: 'read', kind: 'leaf', uuid: id }) }
            catch (error) { if (error.code === 'ENOENT' || error.name === 'NotFoundError') return undefined; throw error }
            if (source === undefined || source === null) return undefined
            if (residentHas(this, id)) { const object = super.get(id); operation?.pin(object.parent ?? object.uuid); return object }
            const data = JSON.parse(source)
            operation?.pin(data.object.parent ?? data.object.uuid)
            object = (await this.restore?.(data, id)) ?? createLeaf(data.object, data.object.root !== 'object')
            if (!residentHas(this, id)) this.set(id, object)
            this.reads++
            object = super.get(id) ?? object
        }
        return object
    }

    reference(id) { return super.get(id) }

    delete(id) {
        if (typeof id !== 'string' || !id) return super.delete(id)
        const object = super.get(id), record = object && this.refs.get(object)
        this.pendingDeletes.add(id)
        this.dirty.delete(id)
        if (record) { record.object = null }
        return super.delete(id)
    }

    async persistDeletes() {
        let count = 0
        for (const id of [...this.pendingDeletes]) {
            if (await this.withWriteLock(id, async () => {
                if (!this.pendingDeletes.has(id)) return false
                await this.disk({ operation: 'delete', kind: 'leaf', uuid: id })
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
                    await this.disk({ operation: 'write', kind: 'leaf', uuid: id, data: (await object.getFile()).content })
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
        const dirty = [...this.dirty]
        const queued = new Map(dirty)
        let next = 0
        const takeDirty = () => {
            if (next >= dirty.length) {
                for (const [id, object] of this.dirty) if (queued.get(id) !== object) {
                    queued.set(id, object)
                    dirty.push([id, object])
                }
            }
            return dirty[next++]
        }
        const workers = Array.from({ length: Math.min(16, dirty.length) }, async () => {
            while (true) {
                const item = takeDirty()
                if (!item) return
                const [id, object] = item
                if (await this.withWriteLock(id, async () => {
                    if (super.get(id) !== object || this.dirty.get(id) !== object) return false
                    await this.disk({ operation: 'write', kind: 'leaf', uuid: id, data: (await object.getFile()).content })
                    if (super.get(id) !== object || this.dirty.get(id) !== object) return false
                    this.dirty.delete(id)
                    this.writes++
                    return true
                })) count++
            }
        })
        await Promise.all(workers)
        return count
    }

    async *references() {
        yield* Map.prototype.values.call(this)
        for (const id of await this.files()) {
            if (residentHas(this, id) || this.pendingDeletes.has(id)) continue
            const data = JSON.parse(await this.disk({ operation: 'read', kind: 'leaf', uuid: id }))
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
        return this.get(record.id)
    }

    releasePersisted(object) {
        const record = object && this.refs.get(object)
        if (!record) return Map.prototype.delete.call(this, object.uuid)
        if (record.object !== object || record.evicted || this.dirty.get(record.id) === object || this.pendingDeletes.has(record.id) || this.pending?.has(object)) return false
        for (const entry of residentIndexEntries(object)) entry.releaseObject()
        super.delete(record.id)
        record.evicted = true
        return true
    }

}

export default LeafTier
