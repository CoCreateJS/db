import planner from './tree/planner.js'
import { Trees } from './trees.js'
import { Organization } from './organization.js'

const modes = new Set(['adaptive', 'disk-first', 'disk-cache'])
const isNode = typeof globalThis.process?.versions?.node === 'string'
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)

export function defaultConfiguration() {
    return {
        version: '1.0.0',
        roots: {
            storage: { database: { array: { object: {}, index: {} } } }
        },
        indexes: [],
        leaves: {},
        memory: { harvestAt: 75, retainAt: 50 }
    }
}

export function createConfiguration(config = {}) {
    const defaults = defaultConfiguration()
    const source = isRecord(config) ? config : {}
    const roots = source.roots ?? defaults.roots
    if (!isRecord(roots)) throw new TypeError('roots must be an ordinary object')
    return {
        ...source,
        version: source.version ?? defaults.version,
        roots: structuredClone(roots),
        leaves: structuredClone(source.leaves ?? {}),
        indexes: structuredClone(source.indexes ?? [])
    }
}

/** Compose the platform disk adapter, tree engine, persistence, planner, and CRUD. */
export async function createRuntime(server = {}, options = {}) {
    const disk = options.disk ?? server.disk
    if (options.directory !== undefined && !disk)
        throw new Error('Initialize Disk with the directory and pass it as server.disk or options.disk')
    const mode = options.mode ?? options.config?.mode ?? (isNode || !disk ? 'adaptive' : 'disk-first')
    if (!modes.has(mode)) throw new Error(`Unsupported database mode: ${mode}`)
    if (mode === 'disk-cache') {
        if (!disk) throw new Error('disk-cache mode requires a disk handler')
        await disk.execute({ operation: 'clear', kind: 'directory' })
    }

    const config = createConfiguration({ ...options.config, ...(options.roots === undefined ? {} : { roots: options.roots }) })
    const db = new DB({
        ...options,
        config,
        server,
        mode,
        disk,
        persistence: options.persistence ?? server.persistence
    })
    if (mode === 'disk-first') db.setDiskFirst(true)
    return db
}

export async function init(server = {}, options = {}) {
    let config = options.config
    if (config === undefined && options.prompt !== false) {
        const { default: Config } = await import('@cocreate/config')
        const result = await Config.prompt(options.questions ?? { db: {} }, true, options.questions !== undefined)
        config = result?.db
    }
    const runtime = await createRuntime(server, { ...options, config })
    const db = {
        get config() { return runtime.config },
        organizations: runtime.organizations,
        send: runtime.send.bind(runtime)
    }
    databaseRuntimes.set(db, runtime)
    return db
}

class DB {
    #server
    #organizations = new Map()
    #telemetryListener
    #disk
    #persistence
    #treeOptions
    #timestamps = new Map()

    constructor(options) {
        const { server, disk, persistence, config, mode } = options
        const plan = options.planner ?? planner
        if (typeof plan !== 'function') throw new TypeError('planner must be a function')
        if (options.execute !== undefined && typeof options.execute !== 'function') throw new TypeError('execute must be a function')
        const configuredMemory = options.memory ?? config.memory ?? {}
        if (!isRecord(configuredMemory)) throw new TypeError('memory must describe node thresholds')
        const policy = { ...defaultConfiguration().memory, ...config.memory, ...configuredMemory }
        if (!Number.isFinite(policy.harvestAt) || !Number.isFinite(policy.retainAt) ||
            policy.retainAt < 0 || policy.harvestAt > 100 || policy.retainAt >= policy.harvestAt)
            throw new TypeError('memory requires 0 <= retainAt < harvestAt <= 100')
        config.memory = policy
        this.initialConfig = config
        this.mode = mode
        this.planner = plan
        this.#server = server
        this.#disk = disk
        this.#persistence = persistence
        this.#treeOptions = { ...options.treeOptions,
            size: options.treeOptions?.size ?? options.size,
            leafSize: options.treeOptions?.leafSize ?? options.leafSize }
        this.memory = { nodeUsedPercent: 0, peakNodeUsedPercent: 0, harvesting: false,
            harvestCycles: 0, treesHarvested: 0, harvestError: undefined, lastHarvest: undefined }
        this.trees = new Trees({ disk, persistence, planner: plan, execute: options.execute, diskFirst: mode === 'disk-first',
            onHarvest: result => {
                this.memory.harvestCycles++
                this.memory.treesHarvested += result.count
                this.memory.lastHarvest = result
            } })
        this.organizations = Object.freeze({ get: this.#getOrganization.bind(this) })
        if (server.on) {
            this.#telemetryListener = message => this.#onTelemetry(message.data)
            server.on('telemetry', this.#telemetryListener)
        }
    }

    async #getOrganization(id) {
        if (typeof id !== 'string' || !id) throw new TypeError('organization_id is required to select a database')
        let pending = this.#organizations.get(id)
        if (!pending) {
            const organization = new Organization(id, { disk: this.#disk, persistence: this.#persistence,
                treeOptions: this.#treeOptions, dispatch: command => this.trees.execute({ ...command, organization_id: id }) })
            pending = organization.init(this.initialConfig)
            this.#organizations.set(id, pending)
            pending.catch(() => { if (this.#organizations.get(id) === pending) this.#organizations.delete(id) })
        }
        return await pending
    }

    #onTelemetry(sample) {
        if (sample.serverId !== this.#server.id || this.#timestamps.get(sample.workerId) === sample.timestamp) return
        this.#timestamps.set(sample.workerId, sample.timestamp)
        const memory = this.memory
        memory.nodeUsedPercent = sample.memory.max
        memory.peakNodeUsedPercent = Math.max(memory.peakNodeUsedPercent, sample.memory.max)
        let active = memory.harvesting
        if (sample.memory.max >= this.initialConfig.memory.harvestAt) active = true
        else if (sample.memory.max <= this.initialConfig.memory.retainAt) active = false
        if (active === memory.harvesting) return
        memory.harvesting = active
        this.trees.execute({ operation: 'pressure', active }).catch(error => { memory.harvestError = error })
    }

    get config() { return structuredClone(this.initialConfig) }
    get disk() { return this.#disk }
    set disk(handler) {
        this.#disk = handler
        this.trees.options.disk = handler
        for (const tables of this.trees.organizations.values()) for (const tree of tables.values()) tree.disk = handler
        for (const pending of this.#organizations.values()) pending.then(organization => { organization.disk = handler })
    }
    get persistence() { return this.#persistence }

    setDiskFirst(enabled) {
        this.trees.options.diskFirst = Boolean(enabled)
        return this.trees.options.diskFirst
    }

    async send(request) {
        const object = request?.object
        const organizationId = request?.organization_id ?? object?.organization_id ??
            (Array.isArray(object) ? object.find(item => item?.organization_id)?.organization_id : undefined)
        try { return await (await this.#getOrganization(organizationId)).execute(request) }
        catch (error) { return { ...request, success: false, error: [error.message] } }
    }

    // Internal diagnostics only; CRUD never waits for either queue.
    async status() { return { ...this.trees.status(), pendingDiskCount: this.pendingDiskCount } }
    get pendingIndexCount() { return this.trees.pendingIndexCount }
    get pendingDiskCount() {
        let count = this.trees.pendingDiskCount
        for (const id of this.#organizations.keys()) count += (this.#disk?.queue[id]?.size ?? 0) + (this.#persistence?.queue[id]?.size ?? 0)
        return count
    }

    async close() {
        if (this.#telemetryListener) {
            this.#server.off('telemetry', this.#telemetryListener)
            this.#telemetryListener = undefined
        }
        await this.trees.execute({ operation: 'pressure', active: false })
        for (const pending of this.#organizations.values()) await (await pending).close()
        this.#organizations.clear()
        await this.trees.close()
        if (this.memory.harvestError) throw this.memory.harvestError
    }
}

// Internal diagnostics only; not exported from the package entry.
export const databaseRuntimes = new WeakMap()
