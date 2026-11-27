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
        memory: { pruneAt: 75, retainAt: 50 }
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
    if (mode === 'disk-cache' && server.isPrimary !== false) {
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
    if (config === undefined && options.prompt !== false && server.isPrimary !== false) {
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
    #worker
    #remote
    #organizations = new Map()
    #listeners = new Map()
    #nextWorker = 0
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
        if (!Number.isFinite(policy.pruneAt) || !Number.isFinite(policy.retainAt) ||
            policy.retainAt < 0 || policy.pruneAt > 100 || policy.retainAt >= policy.pruneAt)
            throw new TypeError('memory requires 0 <= retainAt < pruneAt <= 100')
        config.memory = policy
        this.initialConfig = config
        this.mode = mode
        this.planner = plan
        this.#server = server
        this.#worker = server.isPrimary === false
        this.#remote = server.isPrimary === true && server.isWorker === false
        this.#disk = disk
        this.#persistence = persistence
        this.#treeOptions = { ...options.treeOptions,
            size: options.treeOptions?.size ?? options.size,
            leafSize: options.treeOptions?.leafSize ?? options.leafSize }
        this.memory = { nodeUsedPercent: 0, peakNodeUsedPercent: 0, pruning: false,
            pruneCycles: 0, branchesPruned: 0, pruneError: undefined, lastPrune: undefined }
        this.trees = new Trees({ disk, persistence, planner: plan, execute: options.execute, diskFirst: mode === 'disk-first',
            onPrune: result => {
                this.memory.pruneCycles++
                this.memory.branchesPruned += result.count
                this.memory.lastPrune = result
            } })
        this.organizations = Object.freeze({ get: this.#getOrganization.bind(this) })
        if (this.#worker) {
            this.forward = options.forward ?? (async request => {
                return await this.#request({ method: 'db.forward', request, primary: true, broadcast: false, server: server.id })
            })
            this.#listen('db.tree', async message => {
                try { return { uuid: message.uuid, result: await this.trees.execute(message.tree) } }
                catch (error) { return { uuid: message.uuid, success: false, error: error.message } }
            })
        } else if (server.isPrimary) {
            this.#listen('db.forward', async message => {
                try { return { uuid: message.uuid, result: await this.send(message.request) } }
                catch (error) { return { uuid: message.uuid, success: false, error: error.message } }
            })
            this.#listen('telemetry', message => this.#onTelemetry(message.data))
        }
    }

    #listen(event, listener) {
        this.#listeners.set(event, listener)
        this.#server.on(event, listener)
    }

    async #request(message) {
        const response = await this.#server.send(message)
        if (response.success === false || response.error) throw new Error(response.error || 'Database execution failed')
        return response.result
    }

    #workerIds() { return [...this.#server.workers.keys()] }

    #owner(organization, uuid) {
        if (organization.owners.has(uuid)) return organization.owners.get(uuid)
        let owner = this.#server.workerId ?? 0
        if (this.#remote) {
            const workers = this.#workerIds()
            if (!workers.length) throw new Error('No DB workers are available')
            owner = workers[this.#nextWorker++ % workers.length]
        }
        organization.owners.set(uuid, owner)
        return owner
    }

    async #dispatch(organization, command) {
        const tree = { ...command, organization_id: organization.organizationId, diskFirst: this.trees.options.diskFirst }
        if (!this.#remote) {
            if (command.uuid !== undefined && !['drop', 'prune'].includes(command.operation)) this.#owner(organization, command.uuid)
            return await this.trees.execute(tree)
        }
        const send = worker => this.#request({ method: 'db.tree', tree, server: this.#server.id,
            worker, primary: false, broadcast: false })
        if (command.uuid !== undefined) {
            const owner = ['prune', 'drop', 'configure'].includes(command.operation)
                ? organization.owners.get(command.uuid) : this.#owner(organization, command.uuid)
            if (owner === undefined) return command.operation === 'prune' ? { count: 0 } : undefined
            return await send(owner)
        }
        const workers = [...new Set(organization.owners.values())]
        if (command.operation === 'prune') {
            let count = 0
            for (const worker of workers) {
                if (count >= (command.limit ?? Infinity)) break
                tree.limit = command.limit === undefined ? undefined : command.limit - count
                count += (await send(worker)).count
            }
            return { count }
        }
        const results = await Promise.all(workers.map(send))
        return command.operation === 'lookup' ? results.flat() : results
    }

    async #getOrganization(id) {
        if (this.#worker) throw new Error('Organization routing is owned by the primary; execution Trees reside in workers')
        if (typeof id !== 'string' || !id) throw new TypeError('organization_id is required to select a database')
        let pending = this.#organizations.get(id)
        if (!pending) {
            const organization = new Organization(id, { disk: this.#disk, persistence: this.#persistence,
                treeOptions: this.#treeOptions, dispatch: command => this.#dispatch(organization, command) })
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
        let active = memory.pruning
        if (sample.memory.max >= this.initialConfig.memory.pruneAt) active = true
        else if (sample.memory.max <= this.initialConfig.memory.retainAt) active = false
        if (active === memory.pruning) return
        memory.pruning = active
        this.#pressure(active).catch(error => { memory.pruneError = error })
    }

    async #pressure(active) {
        if (!this.#remote) return await this.trees.execute({ operation: 'pressure', active })
        await Promise.all(this.#workerIds().map(worker => this.#request({ method: 'db.tree', server: this.#server.id,
            worker, primary: false, broadcast: false, tree: { operation: 'pressure', active } })))
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
        if (this.#worker) return await this.forward(request)
        const object = request?.object
        const organizationId = request?.organization_id ?? object?.organization_id ??
            (Array.isArray(object) ? object.find(item => item?.organization_id)?.organization_id : undefined)
        try { return await (await this.#getOrganization(organizationId)).execute(request) }
        catch (error) { return { ...request, success: false, error: [error.message] } }
    }

    // Internal observation is asynchronous across processes; never an index barrier in CRUD.
    async status() {
        if (!this.#remote) return this.trees.status()
        const workers = await Promise.all(this.#workerIds().map(async workerId => ({ workerId,
            ...await this.#request({ method: 'db.tree', server: this.#server.id, worker: workerId,
                primary: false, broadcast: false, tree: { operation: 'status' } }) })))
        return { workers, trees: workers.flatMap(worker => worker.trees.map(tree => ({ ...tree, workerId: worker.workerId }))),
            pendingIndexCount: workers.reduce((sum, worker) => sum + worker.pendingIndexCount, 0) }
    }

    get pendingIndexCount() {
        if (this.#remote) throw new Error('Worker queue observation requires await runtime.status()')
        return this.trees.pendingIndexCount
    }

    async close() {
        for (const [event, listener] of this.#listeners) this.#server.off(event, listener)
        this.#listeners.clear()
        await this.#pressure(false)
        for (const pending of this.#organizations.values()) await (await pending).close()
        this.#organizations.clear()
        await this.trees.close()
        if (this.memory.pruneError) throw this.memory.pruneError
    }
}

// Internal diagnostics only; not exported from the package entry.
export const databaseRuntimes = new WeakMap()
