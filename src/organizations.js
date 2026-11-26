import { CRUD } from './crud.js'
import { createConfiguration, Tree } from './tree/index.js'

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const missing = error => error?.code === 'ENOENT' || error?.name === 'NotFoundError'

function organizationPath(organizationId) {
    return encodeURIComponent(organizationId).replaceAll('.', '%2E')
}

function organizationRoots(roots) {
    if (!Object.hasOwn(roots, '$organization_id')) return roots
    const scoped = roots.$organization_id
    if (!isRecord(scoped)) throw new TypeError('The $organization_id root must contain an object')
    return scoped
}

function scopedConfig(config) {
    return createConfiguration({
        config: {
            ...config,
            roots: organizationRoots(config.roots),
            leaves: {},
            indexes: []
        }
    })
}

export class OrganizationTrees {
    #config
    #template
    #contexts = new Map()
    #disk
    #persistence
    #treeOptions
    #planner
    #diskFirst = false

    constructor({ config, disk, persistence, treeOptions } = {}) {
        this.#config = scopedConfig(createConfiguration({ config }))
        this.#template = this.#config
        this.#disk = disk
        this.#persistence = persistence
        this.#treeOptions = treeOptions ?? {}
        this.leaves = Object.freeze({
            get: (uuid, organizationId) => this.getLeaf(uuid, organizationId),
            has: (uuid, organizationId) => this.hasLeaf(uuid, organizationId)
        })
        this.branches = Object.freeze({
            get: (uuid, organizationId) => this.getBranch(uuid, organizationId)
        })
    }

    get config() { return structuredClone(this.#config) }
    get disk() { return this.#disk }
    set disk(value) { this.#disk = value ?? undefined }
    get persistence() { return this.#persistence }
    set persistence(value) { this.#persistence = value ?? undefined }
    get planner() { return this.#planner }
    set planner(value) {
        this.#planner = value
        for (const pending of this.#contexts.values()) pending.then(({ tree }) => { tree.planner = value }).catch(() => {})
    }
    get diskFirst() { return this.#diskFirst }
    get pendingIndexCount() {
        let count = 0
        for (const pending of this.#contexts.values()) count += pending.tree?.pendingIndexCount ?? 0
        return count
    }

    setDiskFirst(enabled) {
        this.#diskFirst = Boolean(enabled)
        for (const pending of this.#contexts.values()) pending.then(({ tree }) => tree.setDiskFirst(this.#diskFirst)).catch(() => {})
        return this.#diskFirst
    }

    scopedDisk(organizationId) {
        const prefix = organizationPath(organizationId)
        const registry = this
        return {
            async execute(operation = {}) {
                const disk = registry.#disk
                if (!disk || typeof disk.execute !== 'function') throw new Error('Organization Tree requires a Disk adapter')
                if (operation.operation === 'clear') throw new Error('Clearing one organization directory is not supported by this Disk adapter')
                const path = operation.path === undefined ? prefix : `${prefix}/${operation.path}`
                return await disk.execute({ ...operation, path })
            }
        }
    }

    scopedPersistence(organizationId) {
        const registry = this
        return {
            async execute(operation) {
                const persistence = registry.#persistence
                if (!persistence?.execute) return undefined
                return await persistence.execute({ ...operation, organization_id: organizationId })
            }
        }
    }

    async #createContext(organizationId) {
        const disk = this.#disk ? this.scopedDisk(organizationId) : undefined
        let config = this.#template
        if (disk) {
            try {
                const stored = await Tree.readDiskConfig(disk)
                config = createConfiguration({ config: typeof stored === 'string' ? JSON.parse(stored) : stored })
            } catch (error) {
                if (!missing(error)) throw error
            }
        }
        const tree = Tree.prepare({ ...this.#treeOptions, config })
        if (disk) tree.disk = disk
        if (this.#persistence) tree.persistence = this.scopedPersistence(organizationId)
        tree.planner = this.#planner
        if (this.#diskFirst) tree.setDiskFirst(true)
        await tree.initialize()
        const crud = new CRUD(tree, this.#planner)
        return { tree, crud }
    }

    async #context(organizationId) {
        if (typeof organizationId !== 'string' || !organizationId)
            throw new TypeError('organization_id is required to select a database Tree')
        let pending = this.#contexts.get(organizationId)
        if (!pending) {
            pending = this.#createContext(organizationId)
            this.#contexts.set(organizationId, pending)
            pending.then(context => { pending.tree = context.tree }).catch(() => {})
            pending.catch(() => {
                if (this.#contexts.get(organizationId) === pending) this.#contexts.delete(organizationId)
            })
        }
        return await pending
    }

    async send(request = {}) {
        try {
            const { crud } = await this.#context(request.organization_id)
            return await crud.send(request)
        } catch (error) {
            return { ...request, success: false, error: [error.message || String(error)] }
        }
    }

    getOrganizationTree(organizationId) { return this.#context(organizationId).then(({ tree }) => tree) }

    async releaseOrganization(organizationId) {
        const pending = this.#contexts.get(organizationId)
        if (!pending) return false
        const { tree } = await pending
        await tree.flushLocal()
        if (this.#contexts.get(organizationId) === pending) this.#contexts.delete(organizationId)
        return true
    }

    async getLeaf(uuid, organizationId) {
        if (organizationId !== undefined) return await (await this.#context(organizationId)).tree.getLeaf(uuid)
        for (const pending of this.#contexts.values()) {
            const leaf = await (await pending).tree.getLeaf(uuid)
            if (leaf) return leaf
        }
    }

    async hasLeaf(uuid, organizationId) {
        if (organizationId !== undefined) return await (await this.#context(organizationId)).tree.leaves.has(uuid)
        for (const pending of this.#contexts.values()) if (await (await pending).tree.leaves.has(uuid)) return true
        return false
    }

    async getBranch(uuid, organizationId) {
        if (organizationId !== undefined) return await (await this.#context(organizationId)).tree.branches.get(uuid)
        for (const pending of this.#contexts.values()) {
            const branch = await (await pending).tree.branches.get(uuid)
            if (branch) return branch
        }
    }

    async flushIndex() {
        const results = await Promise.all([...this.#contexts.values()].map(async pending => await (await pending).tree.flushIndex()))
        return results.reduce((sum, value) => sum + (Number(value) || 0), 0)
    }

    async flushLocal() {
        await Promise.all([...this.#contexts.values()].map(async pending => await (await pending).tree.flushLocal()))
    }

    async close() {
        const contexts = [...this.#contexts.values()]
        this.#contexts.clear()
        await Promise.all(contexts.map(async pending => await (await pending).tree.flushLocal()))
    }

    async evictLeaf(uuid, organizationId) {
        if (organizationId !== undefined) return await (await this.#context(organizationId)).tree.evictLeaf(uuid)
        for (const pending of this.#contexts.values()) {
            const tree = (await pending).tree
            if (await tree.getLeaf(uuid)) return await tree.evictLeaf(uuid)
        }
        return false
    }

    async prune(options = {}) {
        let remaining = options.limit
        const results = []
        for (const pending of this.#contexts.values()) {
            if (remaining === 0) break
            const result = await (await pending).tree.prune({ ...options, limit: remaining })
            results.push(result)
            if (remaining !== undefined) remaining = Math.max(0, remaining - result.count)
        }
        return {
            strategy: options.strategy ?? 'lfu',
            target: results.reduce((sum, result) => sum + result.target, 0),
            candidates: results.reduce((sum, result) => sum + result.candidates, 0),
            count: results.reduce((sum, result) => sum + result.count, 0),
            skipped: results.reduce((sum, result) => sum + result.skipped, 0)
        }
    }
}

export default OrganizationTrees
