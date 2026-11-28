import { Tree } from './tree/index.js'
import { treeContexts } from './tree/internal.js'

/** Instance-local Trees, indexing, storage queues and harvesting. */
export class Trees {
    constructor(options = {}) {
        this.options = options
        this.organizations = new Map()
        this.harvesting = false
        this.harvestQueue = Promise.resolve()
        this.harvested = 0
    }

    get pendingIndexCount() {
        let count = 0
        for (const tables of this.organizations.values()) for (const tree of tables.values())
            count += treeContexts.get(tree)?.pendingIndexCount ?? 0
        return count
    }

    get pendingDiskCount() {
        let count = 0
        for (const tables of this.organizations.values()) for (const tree of tables.values())
            count += treeContexts.get(tree)?.pendingDiskCount ?? 0
        return count
    }

    async get(organizationId, uuid, config) {
        let tables = this.organizations.get(organizationId)
        if (!tables) this.organizations.set(organizationId, tables = new Map())
        let tree = tables.get(uuid)
        if (!tree) {
            tree = new Tree()
            tree.uuid = uuid
            tree.organizationId = organizationId
            if (this.options.disk) tree.disk = this.options.disk
            if (this.options.persistence) tree.persistence = this.options.persistence
            if (this.options.planner) tree.planner = this.options.planner
            if (this.options.execute) tree.execute = this.options.execute
            tables.set(uuid, tree)
        }
        try { await tree.init(config) }
        catch (error) { if (tables.get(uuid) === tree) tables.delete(uuid); throw error }
        treeContexts.get(tree).onIndexed = () => this.#idle(tree)
        return tree
    }

    #idle(tree) {
        if ((this.options.diskFirst || treeContexts.get(tree).diskFirst) && treeContexts.get(tree).canDrop)
            this.organizations.get(tree.organizationId)?.delete(tree.uuid)
        this.scheduleHarvest()
    }

    status(organizationId) {
        const trees = []
        for (const [id, tables] of this.organizations) {
            if (organizationId !== undefined && id !== organizationId) continue
            for (const tree of tables.values()) {
                const context = treeContexts.get(tree)
                trees.push({ organization_id: id, uuid: tree.uuid, weight: tree.weight, active: tree.active,
                    pendingIndexCount: context?.pendingIndexCount ?? 0, pendingDiskCount: context?.pendingDiskCount ?? 0, canDrop: context?.canDrop ?? false,
                    leafCount: context?.leafCount ?? 0 })
            }
        }
        return { trees, pendingIndexCount: trees.reduce((sum, tree) => sum + tree.pendingIndexCount, 0),
            pendingDiskCount: trees.reduce((sum, tree) => sum + tree.pendingDiskCount, 0), harvested: this.harvested }
    }

    harvest({ organization_id, uuid, limit = Infinity } = {}) {
        if (limit !== Infinity && (!Number.isInteger(limit) || limit < 0)) throw new TypeError('Harvesting limit must be a non-negative integer')
        const candidates = uuid === undefined ? this.status(organization_id).trees.filter(tree => tree.canDrop)
            .sort((a, b) => a.weight - b.weight || a.uuid.localeCompare(b.uuid)) : [{ organization_id, uuid }]
        let count = 0
        for (const candidate of candidates) {
            if (count >= limit) break
            const tables = this.organizations.get(candidate.organization_id)
            const tree = tables?.get(candidate.uuid)
            if (!treeContexts.get(tree)?.canDrop) continue
            tables.delete(candidate.uuid)
            count++
        }
        this.harvested += count
        if (count) this.options.onHarvest?.({ count })
        return { count }
    }

    scheduleHarvest() {
        if (!this.harvesting || this.scheduled) return
        this.scheduled = true
        this.harvestQueue = (async () => {
            while (this.harvesting) {
                if (!this.harvest({ limit: 1 }).count) break
                await new Promise(resolve => setTimeout(resolve, 0))
            }
        })().catch(error => { this.error = error }).finally(() => { this.scheduled = false })
    }

    async execute({ operation, organization_id, uuid, config, request, uuids, roots, limit, active, diskFirst }) {
        if (diskFirst !== undefined) this.options.diskFirst = diskFirst
        if (operation === 'status') return this.status(organization_id)
        if (operation === 'pressure') { this.harvesting = active; this.scheduleHarvest(); return { success: true } }
        if (operation === 'harvest') return this.harvest({ organization_id, uuid, limit })
        if (operation === 'lookup') {
            const found = []
            const tables = this.organizations.get(organization_id)
            for (const id of uuids) for (const tree of tables?.values() ?? []) {
                const leaf = treeContexts.get(tree)?.referenceLeaf(id)
                if (leaf) { found.push({ uuid: leaf.uuid, parent: leaf.parent, root: leaf.root, primary: tree.uuid }); break }
            }
            return found
        }
        if (operation === 'close') return await this.close(organization_id)
        if (operation === 'configure' && !this.organizations.get(organization_id)?.has(uuid)) return
        if (operation === 'drop') { this.organizations.get(organization_id)?.delete(uuid); return }
        // Protect the owner before initialization/storage can yield.
        const pending = this.get(organization_id, uuid, config)
        let tree = this.organizations.get(organization_id)?.get(uuid)
        if (!tree) {
            // Surface initialization failures instead of masking them with an active-counter TypeError.
            await pending
            tree = this.organizations.get(organization_id)?.get(uuid)
            if (!tree) throw new Error(`Tree initialization did not register ${organization_id}/${uuid}`)
        }
        tree.active++
        try {
            await pending
            const context = treeContexts.get(tree)
            switch (operation) {
                case 'execute': return await tree.execute(request)
                case 'hasRoot': return await context.hasRoot(request)
                case 'configure': return await context.configureRoots(roots)
                case 'occupied': return context.pendingIndexCount > 0 || context.pendingDiskCount > 0 || tree.active > 1 || context.leafCount > 0 ||
                    tree.config.indexes.some(index => index.key === 'root' && index.count > 0)
                default: throw new Error(`Unsupported Tree operation: ${operation}`)
            }
        } finally { tree.active--; if (treeContexts.has(tree)) this.#idle(tree) }
    }

    async close(organizationId) {
        if (organizationId === undefined) this.harvesting = false
        await this.harvestQueue
        if (this.error) throw this.error
        for (const [id, tables] of this.organizations) {
            if (organizationId !== undefined && id !== organizationId) continue
            await Promise.all([...tables.values()].map(tree => tree.close()))
            this.organizations.delete(id)
        }
        return { success: true }
    }
}
