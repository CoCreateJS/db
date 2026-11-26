import planner from './tree/planner.js'
import { treeContexts } from './tree/internal.js'
import { Tree } from './tree/index.js'

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
        prune: { strategy: 'lfu' },
        memory: { stages: [25, 50, 75, 90], diskFirst: 90, hysteresis: 2.5 }
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
        indexes: structuredClone(source.indexes ?? []),
        prune: { ...defaults.prune, ...(isRecord(source.prune) ? structuredClone(source.prune) : {}) }
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
    #organizations = new Map()
    #disk
    #persistence
    #treeOptions
    #diskFirst = false

    constructor(options) {
        const {
            config,
            tree,
            execute,
            disk,
            persistence,
            server,
            mode
        } = options
        if (tree && disk) tree.disk = disk
        if (tree && persistence) tree.persistence = persistence
        const configuredPrune = options.prune ?? config.prune
        if (!isRecord(configuredPrune))
            throw new TypeError('Prune configuration must be an object')
        const prune = { ...config.prune, ...configuredPrune, strategy: configuredPrune.strategy ?? config.prune.strategy ?? 'lfu' }
        const plan = options.planner ?? planner
        if (typeof plan !== 'function') throw new TypeError('planner must be a function')
        if (tree) tree.planner = plan
        if (execute && typeof execute !== 'function') throw new TypeError('execute must be a function')
        const configuredMemory = options.memory ?? config.memory ?? {}
        if (!isRecord(configuredMemory)) throw new TypeError('memory must describe node thresholds')
        const memoryPolicy = { ...defaultConfiguration().memory, ...config.memory, ...configuredMemory }
        if (!Array.isArray(memoryPolicy.stages) || memoryPolicy.stages.some((value, index, stages) =>
            !Number.isFinite(value) || value <= 0 || value > 100 || (index > 0 && value <= stages[index - 1])))
            throw new TypeError('memory.stages must be increasing node percentages greater than 0 and at most 100')
        if (!Number.isFinite(memoryPolicy.diskFirst) || memoryPolicy.diskFirst <= 0 || memoryPolicy.diskFirst > 100 ||
            !Number.isFinite(memoryPolicy.hysteresis) || memoryPolicy.hysteresis < 0 || memoryPolicy.hysteresis >= memoryPolicy.diskFirst)
            throw new TypeError('Invalid node memory diskFirst threshold or hysteresis')
        config.memory = { ...memoryPolicy, stages: [...memoryPolicy.stages] }
        const treeOptions = {
            ...options.treeOptions,
            size: options.treeOptions?.size ?? options.size,
            leafSize: options.treeOptions?.leafSize ?? options.leafSize,
            prune
        }
        this.initialConfig = config
        this.tree = tree
        this.#disk = disk
        this.#persistence = persistence
        this.#treeOptions = treeOptions
        this.#diskFirst = mode === 'disk-first'
        this.organizations = Object.freeze({
            get: this.#getOrganization.bind(this)
        })
        this.planner = plan
        this.execute = execute
        if (tree && execute) tree.execute = execute
        this.mode = mode
        this.prune = prune
        this.#server = server
        this.memory = {
            nodeUsedPercent: 0,
            peakNodeUsedPercent: 0,
            stage: 0,
            peakStage: 0,
            pruneCycles: 0,
            branchesPruned: 0,
            diskFirst: this.#diskFirst && !!disk,
            diskFirstActivations: 0,
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
        if (this.tree) {
            this.tree.organizationId ??= organizationId
            return Promise.resolve(this.tree)
        }
        let pending = this.#organizations.get(organizationId)
        if (!pending) {
            pending = this.#createOrganizationTree(organizationId)
            this.#organizations.set(organizationId, pending)
            pending.then(tree => { pending.tree = tree }).catch(() => {
                if (this.#organizations.get(organizationId) === pending) this.#organizations.delete(organizationId)
            })
        }
        return pending
    }

    async #createOrganizationTree(organizationId) {
        const tree = new Tree()
        tree.organizationId = organizationId
        if (this.#disk) tree.disk = this.#disk
        if (this.#persistence) tree.persistence = this.#persistence
        tree.planner = this.planner
        if (this.execute) tree.execute = this.execute
        await tree.init({ ...this.initialConfig, ...this.#treeOptions })
        if (this.#diskFirst && this.#disk) tree.setDiskFirst(true)
        const close = tree.close
        tree.close = async () => {
            await close()
            if (this.#organizations.get(organizationId)?.tree === tree) this.#organizations.delete(organizationId)
        }
        return tree
    }

    async #eachTree(callback) {
        if (this.tree) return await callback(this.tree)
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
        const previousStage = memory.stage
        let stage = previousStage
        while (stage < policy.stages.length && nodeUsedPercent >= policy.stages[stage]) stage++
        while (stage > 0 && nodeUsedPercent < policy.stages[stage - 1] - policy.hysteresis) stage--
        memory.stage = stage
        memory.peakStage = Math.max(memory.peakStage, stage)

        if (this.#disk) {
            const diskFirst = this.mode === 'disk-first' || (memory.diskFirst
                ? nodeUsedPercent >= policy.diskFirst - policy.hysteresis
                : nodeUsedPercent >= policy.diskFirst)
            if (diskFirst !== memory.diskFirst) {
                try {
                    this.setDiskFirst(diskFirst)
                    memory.diskFirst = diskFirst
                    if (diskFirst) memory.diskFirstActivations++
                } catch (error) {
                    memory.pruneError = error
                }
            }
        }

        const prunes = Math.max(0, stage - previousStage)
        if (!prunes || memory.pruneError) return
        this.#pruneQueue = this.#pruneQueue.then(async () => {
            for (let count = 0; count < prunes; count++) {
                memory.lastPrune = await this.#pruneTrees(this.prune)
                memory.pruneCycles++
                memory.branchesPruned += memory.lastPrune.count
            }
        }).catch(error => { memory.pruneError = error })
    }

    get config() {
        return structuredClone(this.initialConfig)
    }

    get disk() { return this.#disk }
    set disk(handler) {
        this.#disk = handler
        this.#eachTree(tree => { tree.disk = handler }).catch(() => {})
    }

    get persistence() { return this.#persistence }

    setDiskFirst(enabled) {
        this.#diskFirst = Boolean(enabled)
        if (this.tree) this.tree.setDiskFirst(this.#diskFirst)
        for (const pending of this.#organizations.values()) pending.tree?.setDiskFirst(this.#diskFirst)
        return this.#diskFirst
    }

    async #pruneTrees(options = {}) {
        const results = []
        await this.#eachTree(async tree => {
            const result = await tree.prune(options)
            results.push(result)
        })
        return {
            strategy: options.strategy ?? 'lfu',
            target: results.reduce((sum, result) => sum + result.target, 0),
            candidates: results.reduce((sum, result) => sum + result.candidates, 0),
            count: results.reduce((sum, result) => sum + result.count, 0),
            skipped: results.reduce((sum, result) => sum + result.skipped, 0)
        }
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
        for (const pending of this.#organizations.values()) count += (pending.tree ? treeContexts.get(pending.tree).pendingIndexCount : 0)
        return count || (this.tree ? treeContexts.get(this.tree).pendingIndexCount : 0)
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
        await this.#pruneQueue
        if (this.memory.pruneError) throw this.memory.pruneError
        const contexts = [...this.#organizations.values()]
        this.#organizations.clear()
        await Promise.all(contexts.map(async pending => await (await pending).close()))
        if (this.tree) await this.tree.close()
    }
}


// Internal diagnostics only; not exported from the package entry.
export const databaseRuntimes = new WeakMap()
