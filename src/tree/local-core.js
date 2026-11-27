import { restoreIndexEntry } from './leaf.js'
export class LocalTier {
    constructor(disk, resolve, { resolveLeaf, referenceLeaf } = {}) {
        this.disk = disk
        this.resolve = resolve
        this.referenceLeaf = referenceLeaf
        this.resolveLeaf = resolveLeaf
        this.resident = new Set()
        this.dirty = new Set()
        this.pendingDiscards = new Set()
        this.reads = 0
    }

    add(index) { this.pendingDiscards.delete(index.uuid); this.resident.add(index) }
    remove(index) { this.resident.delete(index) }

    restore(id, index, value) {
        if (this.resolveLeaf) return restoreIndexEntry(this.referenceLeaf(id), index, value, id)
        return this.resolve(id, index.tree.key)
    }

    takeChanges() {
        const changes = Object.create(null)
        for (const uuid of this.pendingDiscards) changes[uuid] = { operation: 'delete' }
        for (const index of this.dirty) if (this.resident.has(index))
            changes[index.uuid] = { operation: 'write', data: index.getFile().content }
        this.pendingDiscards.clear()
        this.dirty.clear()
        return changes
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
        this.pendingDiscards.add(index.uuid)
        index.onDisk = false
    }
}

export default LocalTier
