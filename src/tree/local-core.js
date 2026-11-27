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
        this.writes = 0
    }

    async deleteLeaf(id) { return await this.disk({ operation: 'delete', kind: 'leaf', uuid: id }) }
    add(index) { this.pendingDiscards.delete(index.uuid); this.resident.add(index) }
    remove(index) { this.resident.delete(index) }

    restore(id, index, value) {
        if (this.resolveLeaf) return restoreIndexEntry(this.referenceLeaf(id), index, value, id)
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
        for (const index of [...this.dirty]) if (this.resident.has(index)) { await this.write(index); count++ }
        return count
    }

    async persistAll() {
        let count = 0
        for (const index of this.resident) { await this.write(index); count++ }
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
