import { bindLeafTier, createLeaf } from './leaf.js'

const residentHas = (tier, id) => Map.prototype.has.call(tier, id)

export class LeafTier extends Map {
    constructor(local) {
        super()
        this.local = local
        this.disk = local.disk
        this.refs = new WeakMap()
        this.reads = 0
    }

    set(id, object) {
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
        if (this.deleted?.has(id)) return false
        if (super.has(id)) return true
        return await this.disk({ operation: 'has', kind: 'leaf', uuid: id })
    }

    async get(id, operation) {
        if (typeof id !== 'string' || !id) return undefined
        if (this.deleted?.has(id)) return undefined
        let object = super.get(id)
        if (!object) {
            let source
            try { source = await this.disk({ operation: 'read', kind: 'leaf', uuid: id }) }
            catch (error) { if (error.code === 'ENOENT' || error.name === 'NotFoundError') return undefined; throw error }
            if (source === undefined || source === null) return undefined
            if (residentHas(this, id)) return super.get(id)
            const data = JSON.parse(source)
            if (!this.belongs(data.object)) return undefined
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
        if (record) { record.object = null }
        return super.delete(id)
    }

    hydrate(record) { return record.object ?? this.get(record.id) }
}

export default LeafTier
