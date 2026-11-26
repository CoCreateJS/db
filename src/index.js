import { CRUD } from './crud.js'
import { createPlanner, QueryPlanner } from './queryPlanner.js'
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
        prune: { strategy: 'lfu' }
    }
}

export function createConfiguration(config = {}) {
    const defaults = defaultConfiguration()
    const source = isRecord(config) ? config : {}
    const roots = source.roots ?? defaults.roots
    if (!isRecord(roots)) throw new TypeError('roots must be an ordinary object')
    return {
        version: source.version ?? defaults.version,
        roots: structuredClone(roots),
        leaves: structuredClone(source.leaves ?? {}),
        indexes: structuredClone(source.indexes ?? []),
        prune: { ...defaults.prune, ...(isRecord(source.prune) ? structuredClone(source.prune) : {}) }
    }
}

/** Compose the platform disk adapter, tree engine, persistence, planner, and CRUD. */
export async function createDB(server = {}, options = {}) {
    if (server.isPrimary === false) {
        const forward = options.forward ?? (typeof server?.send === 'function'
            ? async request => {
                const response = await server.send({
                    method: 'db.forward',
                    request,
                    primary: true,
                    broadcast: false
                })
                if (!response || response.success === false || response.error)
                    throw new Error(response?.error || 'Primary database request failed.')
                return response.result
            }
            : undefined)
        if (typeof forward !== 'function') throw new Error('worker IPC adapter required')
        return {
            config: structuredClone(options.config ?? defaultConfiguration()),
            mode: options.mode ?? options.config?.mode ?? (isNode ? 'adaptive' : 'disk-first'),
            send: async request => await forward(request),
            close: async () => { }
        }
    }

    const disk = options.disk ?? server?.disk
    if (options.directory !== undefined && !disk)
        throw new Error('Initialize Disk with the directory and pass it as server.disk or options.disk')
    const mode = options.mode ?? options.config?.mode ?? (isNode || !disk ? 'adaptive' : 'disk-first')
    if (!modes.has(mode)) throw new Error(`Unsupported database mode: ${mode}`)
    if (mode === 'disk-cache') {
        if (!disk) throw new Error('disk-cache mode requires a disk handler')
        await Tree.clearDisk(disk)
    }

    const config = await loadConfiguration(options)
    const db = new DB({
        ...options,
        config,
        server,
        mode,
        disk,
        persistence: options.persistence ?? server?.persistence
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
    return await createDB(server, { ...options, config })
}

createDB.init = init

const pressureStages = [0.10, 0.20, 0.30, 0.40, 0.50, 0.60, 0.80, 0.90]
const diskFirstPressure = 0.90
const memoryHysteresis = 0.025
async function loadConfiguration(options) {
    if (options.config !== undefined || options.roots !== undefined) {
        return createConfiguration({ ...(options.config ?? {}), ...(options.roots === undefined ? {} : { roots: options.roots }) })
    }

    return defaultConfiguration()
}

class DB {

    #server
    #telemetryListener
    #forwardListener
    #telemetryTimestamps = new Map()
    #memoryQueue = Promise.resolve()
    #organizations = new Map()
    #disk
    #persistence
    #treeOptions
    #diskFirst = false

    constructor(options = {}) {
        const {
            config,
            tree,
            crud,
            disk = options.server?.disk,
            persistence = options.server?.persistence,
            server = {},
            mode = 'adaptive'
        } = options
        if (persistence != null && typeof persistence.execute !== 'function')
            throw new TypeError('DB requires a Tree Persistence resource with execute(operation)')
        if (tree && disk) tree.disk = disk
        if (tree && persistence) tree.persistence = persistence
        const configuredPrune = options.prune ?? config?.prune
        if (configuredPrune !== undefined && (!configuredPrune || typeof configuredPrune !== 'object' || Array.isArray(configuredPrune)))
            throw new TypeError('Prune configuration must be an object')
        const prune = { ...(config?.prune ?? {}), ...(configuredPrune ?? {}), strategy: configuredPrune?.strategy ?? config?.prune?.strategy ?? 'lfu' }
        const planner = createPlanner(options.planner ?? new QueryPlanner())
        if (tree) tree.planner = planner
        if (crud && typeof crud.send !== 'function') throw new TypeError('DB requires a CRUD resource with send(request)')
        const memory = options.memory
        const configuredMemory = options.memoryPercent
            ?? memory?.percent
            ?? (typeof memory === 'number' ? memory : undefined)
            ?? (typeof config?.memory === 'number' ? config.memory : undefined)
        const memoryPercent = configuredMemory === undefined ? 25 : Number(configuredMemory)
        if (!Number.isFinite(memoryPercent) || memoryPercent < 0 || memoryPercent > 100)
            throw new Error('memoryPercent must be between 0 and 100')
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
        this.organization = Object.freeze({
            get: organizationId => this.#organizationTree(organizationId),
            release: organizationId => this.#releaseOrganization(organizationId)
        })
        this.planner = planner
        this.crud = crud
        this.mode = mode
        this.prune = prune
        this.#server = server
        this.memory = {
            percent: memoryPercent,
            totalMemory: undefined,
            availableMemory: undefined,
            requestedBudget: undefined,
            budget: undefined,
            baselineUsedMemory: undefined,
            baselineReady: false,
            usedMemory: undefined,
            pressure: 0,
            peakPressure: 0,
            stage: 0,
            peakStage: 0,
            pruneCycles: 0,
            branchesPruned: 0,
            diskFirst: false,
            diskFirstActivations: 0,
            pruneError: undefined,
            lastPrune: undefined
        }
        this.memoryPolicy = this.memory

        if (server.isPrimary && typeof server.on === 'function') {
            this.#telemetryListener = message => this.#onTelemetry(message)
            server.on('telemetry', this.#telemetryListener)
        }
        if (server.isPrimary && typeof server.on === 'function') {
            this.#forwardListener = async payload => {
                try { return { uuid: payload.uuid, result: await this.send(payload.request) } }
                catch (error) { return { uuid: payload.uuid, success: false, error: error.message || String(error) } }
            }
            server.on('db.forward', this.#forwardListener)
        }
    }

    #organizationContext(organizationId) {
        if (typeof organizationId !== 'string' || !organizationId)
            throw new TypeError('organization_id is required to select a database Tree')
        if (this.tree) {
            this.tree.organizationId ??= organizationId
            return Promise.resolve({ tree: this.tree, crud: this.crud ?? new CRUD(this.tree, this.planner) })
        }
        let pending = this.#organizations.get(organizationId)
        if (!pending) {
            pending = this.#storeOrganization(organizationId)
        }
        return pending
    }

    #storeOrganization(organizationId) {
        const pending = this.#createOrganizationTree(organizationId)
        this.#organizations.set(organizationId, pending)
        pending.then(({ tree }) => { pending.tree = tree }).catch(() => {
            if (this.#organizations.get(organizationId) === pending) this.#organizations.delete(organizationId)
        })
        return pending
    }

    async #organizationTree(organizationId) {
        return (await this.#organizationContext(organizationId)).tree
    }

    async #createOrganizationTree(organizationId) {
        const tree = new Tree()
        tree.organizationId = organizationId
        if (this.#disk) tree.disk = this.#disk
        if (this.#persistence) tree.persistence = this.#persistence
        tree.planner = this.planner
        await tree.init({ ...this.initialConfig, ...this.#treeOptions })
        if (this.#diskFirst && this.#disk) tree.setDiskFirst(true)
        return { tree, crud: new CRUD(tree, this.planner) }
    }

    async #releaseOrganization(organizationId) {
        const pending = this.#organizations.get(organizationId)
        if (!pending) return false
        const { tree } = await pending
        await tree.close()
        if (this.#organizations.get(organizationId) === pending) this.#organizations.delete(organizationId)
        return true
    }

    async #eachTree(callback) {
        if (this.tree) return await callback(this.tree)
        for (const pending of this.#organizations.values()) await callback((await pending).tree)
    }

    #onTelemetry(message) {
        const sample = message.data
        if (this.#server.id != null && String(sample.serverId) !== String(this.#server.id)) return
        const timestamp = sample.timestamp
        const workerId = sample.workerId
        if (this.#telemetryTimestamps.get(workerId) === timestamp) return
        this.#telemetryTimestamps.set(workerId, timestamp)

        const total = sample.memory.total
        const maximum = sample.memory.max
        const usedMemory = total * maximum / 100
        const memory = this.memory
        memory.usedMemory = usedMemory

        if (!memory.baselineReady) {
            memory.totalMemory = total
            memory.baselineUsedMemory = usedMemory
            memory.availableMemory = Math.max(0, total - usedMemory)
            memory.requestedBudget = total * memory.percent / 100
            memory.budget = Math.min(memory.requestedBudget, memory.availableMemory)
            memory.baselineReady = true
            if (memory.budget === 0) this.#applyPressure(1)
            return
        }

        const addedMemory = Math.max(0, usedMemory - memory.baselineUsedMemory)
        this.#applyPressure(memory.budget > 0 ? addedMemory / memory.budget : 1)
    }

    #applyPressure(pressure) {
        const memory = this.memory
        memory.pressure = pressure
        memory.peakPressure = Math.max(memory.peakPressure, pressure)
        const previousStage = memory.stage
        let stage = previousStage
        while (stage < pressureStages.length && pressure >= pressureStages[stage]) stage++
        while (stage > 0 && pressure < pressureStages[stage - 1] - memoryHysteresis) stage--
        memory.stage = stage
        memory.peakStage = Math.max(memory.peakStage, stage)

        if (typeof this.#disk?.execute === 'function') {
            const diskFirst = memory.diskFirst
                ? pressure >= diskFirstPressure - memoryHysteresis
                : pressure >= diskFirstPressure
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
        this.#memoryQueue = this.#memoryQueue.then(async () => {
            for (let count = 0; count < prunes; count++) {
                memory.lastPrune = await this.#pruneTrees(this.prune)
                memory.pruneCycles++
                memory.branchesPruned += memory.lastPrune?.count ?? 0
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
        this.#eachTree(tree => tree.setDiskFirst(this.#diskFirst)).catch(() => {})
        return this.#diskFirst
    }

    async #pruneTrees(options = {}) {
        let remaining = options.limit
        const results = []
        await this.#eachTree(async tree => {
            if (remaining === 0) return
            const result = await tree.prune({ ...options, ...(remaining === undefined ? {} : { limit: remaining }) })
            results.push(result)
            if (remaining !== undefined) remaining = Math.max(0, remaining - result.count)
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
        if (this.crud) return await this.crud.send(request)
        const object = request?.object
        const organizationId = request?.organization_id
            ?? object?.organization_id
            ?? (Array.isArray(object) ? object.find(item => item?.organization_id)?.organization_id : undefined)
        if (typeof organizationId !== 'string' || !organizationId)
            return { ...request, success: false, error: ['organization_id is required to select a database Tree'] }
        const { crud } = await this.#organizationContext(organizationId)
        return await crud.send(request)
    }

    get pendingIndexCount() {
        let count = 0
        for (const pending of this.#organizations.values()) count += pending.tree?.pendingIndexCount ?? 0
        return count || this.tree?.pendingIndexCount || 0
    }

    async persist() {
        const persistence = this.persistence
        if (!persistence) return { success: false, skipped: true }
        if (typeof persistence.persist !== 'function') return { success: true, skipped: true }
        return await persistence.persist()
    }

    async close() {
        if (this.#forwardListener) {
            if (typeof this.#server.off === 'function') this.#server.off('db.forward', this.#forwardListener)
            else this.#server.removeListener?.('db.forward', this.#forwardListener)
            this.#forwardListener = undefined
        }
        if (this.#telemetryListener) {
            if (typeof this.#server.off === 'function') this.#server.off('telemetry', this.#telemetryListener)
            else this.#server.removeListener?.('telemetry', this.#telemetryListener)
            this.#telemetryListener = undefined
        }
        await this.#memoryQueue
        if (this.memory.pruneError) throw this.memory.pruneError
        const contexts = [...this.#organizations.values()]
        this.#organizations.clear()
        await Promise.all(contexts.map(async pending => await (await pending).tree.close()))
        if (this.tree) await this.tree.close?.()
    }
}

export { Tree }
export { CRUD, createCRUD } from './crud.js'
export { QueryPlanner, planQuery } from './queryPlanner.js'

export default createDB
