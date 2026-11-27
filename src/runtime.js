import planner from './tree/planner.js'
import { treeContexts } from './tree/internal.js'
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
    if (server.isPrimary === false) {
        if (options.forward !== undefined && typeof options.forward !== 'function')
            throw new TypeError('forward must be a function')
        const forward = options.forward ?? (async request => {
            const response = await server.send({ method: 'db.forward', request, primary: true, broadcast: false })
            if (response.success === false || response.error)
                throw new Error(response.error || 'Primary database request failed.')
            return response.result
        })
        return {
            config: structuredClone(options.config ?? defaultConfiguration()),
            mode: options.mode ?? options.config?.mode ?? (isNode ? 'adaptive' : 'disk-first'),
            organizations: { async get() { throw new Error('Organization Trees are owned by the primary') } },
            send: forward,
            close: async () => { }
        }
    }

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
    #telemetryListener
    #forwardListener
    #telemetryTimestamps = new Map()
    #pruneQueue = Promise.resolve()
    #pruning = false
    #organizations = new Map()
    #disk
    #persistence
    #treeOptions
    #diskFirst = false

    constructor(options) {
        const {
            config,
            execute,
            disk,
            persistence,
            server,
            mode
        } = options
        const plan = options.planner ?? planner
        if (typeof plan !== 'function') throw new TypeError('planner must be a function')
        if (execute && typeof execute !== 'function') throw new TypeError('execute must be a function')
        const configuredMemory = options.memory ?? config.memory ?? {}
        if (!isRecord(configuredMemory)) throw new TypeError('memory must describe node thresholds')
        const memoryPolicy = { ...defaultConfiguration().memory, ...config.memory, ...configuredMemory }
        if (!Number.isFinite(memoryPolicy.pruneAt) || !Number.isFinite(memoryPolicy.retainAt) ||
            memoryPolicy.retainAt < 0 || memoryPolicy.pruneAt > 100 || memoryPolicy.retainAt >= memoryPolicy.pruneAt)
            throw new TypeError('memory requires 0 <= retainAt < pruneAt <= 100')
        config.memory = memoryPolicy
        const treeOptions = {
            ...options.treeOptions,
            size: options.treeOptions?.size ?? options.size,
            leafSize: options.treeOptions?.leafSize ?? options.leafSize
        }
        this.initialConfig = config
        this.#disk = disk
        this.#persistence = persistence
        this.#treeOptions = treeOptions
        this.#diskFirst = mode === 'disk-first'
        this.organizations = Object.freeze({
            get: this.#getOrganization.bind(this)
        })
        this.planner = plan
        this.execute = execute
        this.mode = mode
        this.#server = server
        this.memory = {
            nodeUsedPercent: 0,
            peakNodeUsedPercent: 0,
            pruning: false,
            pruneCycles: 0,
            branchesPruned: 0,
            pruneError: undefined,
            lastPrune: undefined
        }


        if (server.isPrimary) {
            this.#telemetryListener = message => this.#onTelemetry(message)
            server.on('telemetry', this.#telemetryListener)
            this.#forwardListener = async payload => {
                try { return { uuid: payload.uuid, result: await this.send(payload.request) } }
                catch (error) { return { uuid: payload.uuid, success: false, error: error.message || String(error) } }
            }
            server.on('db.forward', this.#forwardListener)
        }
    }

    #getOrganization(organizationId) {
        if (typeof organizationId !== 'string' || !organizationId)
            throw new TypeError('organization_id is required to select a database Tree')
        let pending = this.#organizations.get(organizationId)
        if (!pending) {
            pending = this.#createOrganization(organizationId)
            this.#organizations.set(organizationId, pending)
            pending.then(organization => { pending.organization = organization }).catch(() => {
                if (this.#organizations.get(organizationId) === pending) this.#organizations.delete(organizationId)
            })
        }
        return pending
    }

    async #createOrganization(organizationId) {
        return await new Organization(organizationId, {
            disk: this.#disk, persistence: this.#persistence, planner: this.planner, execute: this.execute,
            treeOptions: this.#treeOptions,
            onIndexed: (organization, completed) => {
                if (this.#diskFirst) organization.prune(completed ? { uuid: completed.uuid } : undefined).catch(error => { this.memory.pruneError = error })
                else if (completed && treeContexts.get(completed).diskFirst)
                    organization.prune({ uuid: completed.uuid }).catch(error => { this.memory.pruneError = error })
                this.#schedulePrune()
            }
        }).init(this.initialConfig)
    }

    async #eachOrganization(callback) {
        for (const pending of this.#organizations.values()) await callback(await pending)
    }

    #onTelemetry(message) {
        const sample = message.data
        if (sample.serverId !== this.#server.id) return
        const timestamp = sample.timestamp
        const workerId = sample.workerId
        if (this.#telemetryTimestamps.get(workerId) === timestamp) return
        this.#telemetryTimestamps.set(workerId, timestamp)

        this.#applyMemoryPolicy(sample.memory.max)
    }

    #applyMemoryPolicy(nodeUsedPercent) {
        const memory = this.memory
        const policy = this.initialConfig.memory
        memory.nodeUsedPercent = nodeUsedPercent
        memory.peakNodeUsedPercent = Math.max(memory.peakNodeUsedPercent, nodeUsedPercent)
        if (nodeUsedPercent >= policy.pruneAt) memory.pruning = true
        else if (nodeUsedPercent <= policy.retainAt) memory.pruning = false
        this.#schedulePrune()
    }

    #schedulePrune() {
        if (!this.memory.pruning || this.#pruning) return
        this.#pruning = true
        this.#pruneQueue = (async () => {
            while (this.memory.pruning) {
                let candidate
                await this.#eachOrganization(organization => {
                    for (const tree of organization.pruneCandidates) {
                        if (!candidate || tree.weight < candidate.tree.weight ||
                            tree.weight === candidate.tree.weight && tree.uuid < candidate.tree.uuid)
                            candidate = { organization, tree }
                    }
                })
                if (!this.memory.pruning || !candidate) break
                const { organization, tree } = candidate
                const result = await organization.prune({ uuid: tree.uuid })
                this.memory.lastPrune = result
                this.memory.pruneCycles++
                this.memory.branchesPruned += result.count
                if (!result.count) break
                // Allow incoming work and telemetry to run between whole-table removals.
                await new Promise(resolve => setTimeout(resolve, 0))
            }
        })().catch(error => { this.memory.pruneError = error }).finally(() => { this.#pruning = false })
    }

    get config() {
        return structuredClone(this.initialConfig)
    }

    get disk() { return this.#disk }
    set disk(handler) {
        this.#disk = handler
        this.#eachOrganization(organization => {
            organization.disk = handler
            for (const tree of organization.trees.values()) tree.disk = handler
        }).catch(() => {})
    }

    get persistence() { return this.#persistence }

    setDiskFirst(enabled) {
        this.#diskFirst = Boolean(enabled)
        return this.#diskFirst
    }

    async send(request) {
        const object = request?.object
        const organizationId = request?.organization_id
            ?? object?.organization_id
            ?? (Array.isArray(object) ? object.find(item => item?.organization_id)?.organization_id : undefined)
        try {
            const tree = await this.#getOrganization(organizationId)
            return await tree.execute(request)
        } catch (error) {
            return { ...request, success: false, error: [error.message] }
        }
    }

    get pendingIndexCount() {
        let count = 0
        for (const pending of this.#organizations.values()) count += pending.organization?.pendingIndexCount ?? 0
        return count
    }

    async close() {
        if (this.#forwardListener) {
            this.#server.off('db.forward', this.#forwardListener)
            this.#forwardListener = undefined
        }
        if (this.#telemetryListener) {
            this.#server.off('telemetry', this.#telemetryListener)
            this.#telemetryListener = undefined
        }
        this.memory.pruning = false
        await this.#pruneQueue
        if (this.memory.pruneError) throw this.memory.pruneError
        const contexts = [...this.#organizations.values()]
        this.#organizations.clear()
        await Promise.all(contexts.map(async pending => await (await pending).close()))
    }
}


// Internal diagnostics only; not exported from the package entry.
export const databaseRuntimes = new WeakMap()
