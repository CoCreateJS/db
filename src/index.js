import { CRUD } from './crud.js'
import { createPlanner, QueryPlanner } from './queryPlanner.js'
import { createConfiguration, createTree, defaultConfiguration, Tree } from './tree/index.js'

const modes = new Set(['adaptive', 'disk-first', 'disk-cache'])
const isNode = typeof globalThis.process?.versions?.node === 'string'

/** Compose the platform disk adapter, tree engine, persistence, planner, and CRUD. */
export async function createDB(server = {}, options = {}) {
    const primary = server?.isPrimary ?? (server?.isWorker === true ? false : true)
    if (!primary) {
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
            flushIndex: async () => {},
            flushDisk: async () => {},
            close: async () => {}
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

    const db = await createIndex({
        ...options,
        server,
        mode,
        disk,
        treeOptions: {
            size: options.size,
            leafSize: options.leafSize,
            deferIndex: options.deferIndex,
            ...options.treeOptions
        }
    })
    if (mode === 'disk-first') db.tree.setDiskFirst(true)
    return db
}

export async function init(server = {}, options = {}) {
    const primary = server?.isPrimary ?? (server?.isWorker === true ? false : true)
    let config = options.config
    if (config === undefined && options.prompt !== false && primary) {
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
const isMissingConfig = error => error?.code === 'ENOENT' || error?.name === 'NotFoundError'

async function loadConfiguration(options, disk) {
    if (options.config !== undefined || options.roots !== undefined) {
        return createConfiguration({ config: options.config, roots: options.roots })
    }

    if (disk) {
        try {
            const saved = await Tree.readDiskConfig(disk)
            return createConfiguration({ config: typeof saved === 'string' ? JSON.parse(saved) : saved })
        } catch (error) {
            if (!isMissingConfig(error)) throw error
        }
    }
    return defaultConfiguration()
}

/**
 * Index is the composition root: resolve config, initialize Tree, then wire
 * the planner and CRUD resource. It does not plan or execute data operations.
 */
export class Index {
    static async create(options = {}) {
        const disk = options.disk ?? options.server?.disk ?? options.tree?.disk
        const persistence = options.persistence ?? options.server?.persistence ?? options.tree?.persistence
        const config = options.tree?.config ?? await loadConfiguration(options, disk)
        let tree
        if (persistence !== undefined && persistence !== null && typeof persistence.execute !== 'function')
            throw new TypeError('Index requires a Tree Persistence resource with execute(operation)')
        tree = options.tree ?? Tree.prepare({
            ...options.treeOptions,
            config,
        })
        if (disk) tree.disk = disk
        if (persistence) tree.persistence = persistence
        if (!options.tree) await tree.initialize()
        if (options.tree) {
            if (persistence) tree.persistence = persistence
        }
        const configuredPrune = options.prune ?? options.config?.prune
        if (configuredPrune !== undefined && (!configuredPrune || typeof configuredPrune !== 'object' || Array.isArray(configuredPrune)))
            throw new TypeError('Prune configuration must be an object')
        const prune = configuredPrune === undefined
            ? { strategy: 'lfu' }
            : { ...configuredPrune, strategy: configuredPrune.strategy ?? 'lfu' }
        const planner = createPlanner(options.planner ?? new QueryPlanner())
        tree.planner = planner
        const crud = options.crud ?? new CRUD(tree)
        if (typeof crud.send !== 'function') throw new TypeError('Index requires a CRUD resource with send(request)')
        const configuredMemory = options.memoryPercent
            ?? options.memory?.percent
            ?? (typeof options.memory === 'number' ? options.memory : undefined)
            ?? (typeof options.config?.memory === 'number' ? options.config.memory : undefined)
        const memoryPercent = configuredMemory === undefined ? 25 : Number(configuredMemory)
        if (!Number.isFinite(memoryPercent) || memoryPercent < 0 || memoryPercent > 100)
            throw new Error('memoryPercent must be between 0 and 100')
        return new Index({ config, tree, planner, crud, server: options.server, memoryPercent, prune, mode: options.mode ?? options.config?.mode ?? 'adaptive' })
    }

    #server
    #telemetryListener
    #forwardListener
    #telemetryTimestamps = new Map()
    #memoryQueue = Promise.resolve()
    #diskFirstLeaves = new Set()
    #diskQueue = Promise.resolve()
    #diskError
    #flushTimer

    constructor({ config, tree, planner, crud, server = {}, memoryPercent = 25, prune = { strategy: 'lfu' }, mode = 'adaptive' }) {
        this.initialConfig = config
        this.tree = tree
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

        const primary = server?.isPrimary ?? (server?.isWorker === true ? false : true)
        if (primary && typeof server.on === 'function') {
            this.#telemetryListener = message => this.#onTelemetry(message)
            server.on('telemetry', this.#telemetryListener)
        }
        if (primary && typeof server.on === 'function') {
            this.#forwardListener = async payload => {
                try { return { uuid: payload.uuid, result: await this.send(payload.request) } }
                catch (error) { return { uuid: payload.uuid, success: false, error: error.message || String(error) } }
            }
            server.on('db.forward', this.#forwardListener)
        }
    }

    #onTelemetry(message) {
        const sample = message?.data
        if (!sample || (this.#server.id != null && String(sample.serverId) !== String(this.#server.id))) return
        const timestamp = sample.timestamp
        const workerId = String(sample.workerId ?? message.workerId ?? 0)
        if (typeof timestamp !== 'string' || this.#telemetryTimestamps.get(workerId) === timestamp) return
        this.#telemetryTimestamps.set(workerId, timestamp)

        const total = Number(sample.memory?.total)
        const maximum = Number(sample.memory?.max)
        if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(maximum) || maximum < 0 || maximum > 100) return
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

        if (typeof this.tree.disk?.execute === 'function') {
            const diskFirst = memory.diskFirst
                ? pressure >= diskFirstPressure - memoryHysteresis
                : pressure >= diskFirstPressure
            if (diskFirst !== memory.diskFirst) {
                try {
                    this.tree.setDiskFirst(diskFirst)
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
                memory.lastPrune = await this.tree.prune(this.prune)
                memory.pruneCycles++
                memory.branchesPruned += memory.lastPrune?.count ?? 0
            }
        }).catch(error => { memory.pruneError = error })
    }

    get config() {
        const config = this.tree?.config ?? structuredClone(this.initialConfig)
        return { ...config, prune: this.prune }
    }

    get disk() { return this.tree?.disk }
    set disk(handler) { if (this.tree) this.tree.disk = handler }

    async send(request) {
        const response = await this.crud.send(request)
        if (response?.success !== false) {
            const operation = String(request?.method ?? '').split('.')[1]
            if (this.tree.diskFirst) {
                const root = String(request?.method ?? '').split('.')[0]
                for (const leaf of response?.[root] ?? []) if (typeof leaf?.uuid === 'string') this.#diskFirstLeaves.add(leaf.uuid)
            }
            if ((operation !== 'read' || this.tree.diskFirst && this.#diskFirstLeaves.size) && this.#flushTimer === undefined) {
                this.#flushTimer = setTimeout(() => {
                    this.#flushTimer = undefined
                    this.#diskQueue = this.#diskQueue.then(async () => {
                        await this.tree.flushLocal()
                        await this.#releaseDiskFirstLeaves()
                    }).catch(error => { this.#diskError = error })
                }, 0)
            }
        }
        return response
    }

    async #releaseDiskFirstLeaves() {
        if (!this.#diskFirstLeaves.size) return
        const ids = [...this.#diskFirstLeaves]
        this.#diskFirstLeaves.clear()
        for (const id of ids) await this.tree.evictLeaf(id)
    }

    async flushIndex() { return await this.tree?.flushIndex?.() }

    async flushLocal() {
        if (this.#flushTimer !== undefined) {
            clearTimeout(this.#flushTimer)
            this.#flushTimer = undefined
        }
        await this.#diskQueue
        if (this.#diskError) throw this.#diskError
        const result = await this.tree?.flushLocal?.()
        await this.#releaseDiskFirstLeaves()
        return result
    }

    get pendingIndexCount() { return this.tree?.pendingIndexCount ?? 0 }

    async flushDisk() { return await this.flushLocal() }

    async persist() {
        const persistence = this.persistence
        if (!persistence) return { success: false, skipped: true }
        if (typeof persistence.persist !== 'function') return { success: true, skipped: true }
        return await persistence.persist()
    }

    get persistence() { return this.tree?.persistence }

    async flushMemory() {
        await this.#memoryQueue
        if (this.memory.pruneError) throw this.memory.pruneError
        return this.memory.lastPrune
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
        await this.flushMemory()
        await this.flushLocal()
    }
}

export async function createIndex(options) { return await Index.create(options) }

export { Tree, createTree, createConfiguration, defaultConfiguration }
export { CRUD, createCRUD } from './crud.js'
export { QueryPlanner, planQuery } from './queryPlanner.js'

export default createDB
