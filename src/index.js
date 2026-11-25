import { CRUD } from './crud/index.js'
import { QueryPlanner } from './query-planner/index.js'
import { createConfiguration, createTree, defaultConfiguration, Tree } from './tree/index.js'
import { createPlatformDisk, createStorageDisk, requestDisk } from './disk/index.js'
import { Persistence } from './persistence/index.js'

const modes = new Set(['adaptive', 'disk-first', 'disk-cache'])
const isNode = typeof globalThis.process?.versions?.node === 'string'

/** Compose the platform disk adapter, tree engine, persistence, planner, and CRUD. */
export async function createDB(server = {}, options = {}) {
    const primary = server.isPrimary ?? (server.isWorker === true ? false : true)
    if (!primary) {
        if (typeof options.forward !== 'function') throw new Error('worker IPC adapter required')
        return {
            config: structuredClone(options.config ?? defaultConfiguration()),
            mode: options.mode ?? options.config?.mode ?? (isNode ? 'adaptive' : 'disk-first'),
            send: async request => await options.forward(request),
            flushIndex: async () => {},
            flushDisk: async () => {},
            close: async () => {}
        }
    }

    const mode = options.mode ?? options.config?.mode ?? (isNode ? 'adaptive' : 'disk-first')
    if (!modes.has(mode)) throw new Error(`Unsupported database mode: ${mode}`)
    const platform = options.disk ? undefined : await createPlatformDisk({ directory: options.directory, storage: options.storage })
    const storage = platform?.storage ?? options.storage
    const disk = options.disk ?? platform?.disk ?? (storage ? createStorageDisk(storage) : undefined)
    if (mode === 'disk-cache') {
        if (typeof storage?.clear !== 'function') throw new Error('disk-cache mode requires a disk storage adapter that supports clear()')
        await storage.clear()
    }

    const db = await createIndex({
        ...options,
        server,
        mode,
        storage: undefined,
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
    const primary = server.isPrimary ?? (server.isWorker === true ? false : true)
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

function snapshotResponse(request, response) {
    const root = String(request?.method ?? '').split('.')[0]
    if (!Array.isArray(response?.[root])) return response
    return {
        ...response,
        [root]: response[root].map(value => value && typeof value === 'object'
            ? structuredClone(Object.fromEntries(Object.entries(value)))
            : value)
    }
}

async function loadConfiguration(options, disk) {
    if (options.config !== undefined || options.roots !== undefined) {
        return createConfiguration({ config: options.config, roots: options.roots })
    }

    if (disk) {
        try {
            const saved = await requestDisk(disk, 'disk.read', { kind: 'config' })
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
        const disk = options.disk ?? (options.storage ? createStorageDisk(options.storage) : undefined)
        if (disk) await requestDisk(disk, 'disk.initialize')
        const config = options.tree?.config ?? await loadConfiguration(options, disk)
        let tree
        const persistence = options.persistence ?? new Persistence({
            pending: options.pending,
            get: async uuid => await tree?.getLeaf(uuid),
            send: options.persistenceSend
        })
        if (typeof persistence.stage !== 'function' || typeof persistence.persist !== 'function')
            throw new TypeError('Index requires a Persistence resource with stage(envelope) and persist()')
        tree = options.tree ?? await createTree({
            ...options.treeOptions,
            config,
            disk,
            read: typeof persistence.read === 'function' ? uuid => persistence.read(uuid) : undefined,
            diskInitialized: true,
            persist: options.persist ?? (envelope => persistence.stage(envelope))
        })
        if (options.tree) {
            if (disk) tree.disk = disk
            tree.persist = options.persist ?? (envelope => persistence.stage(envelope))
            tree.setReadExternal?.(typeof persistence.read === 'function' ? uuid => persistence.read(uuid) : undefined)
        }
        const planner = options.planner ?? new QueryPlanner()
        const crud = options.crud ?? new CRUD(tree, planner)
        if (typeof crud.send !== 'function') throw new TypeError('Index requires a CRUD resource with send(request)')
        const configuredMemory = options.memoryPercent
            ?? options.memory?.percent
            ?? (typeof options.memory === 'number' ? options.memory : undefined)
            ?? (typeof options.config?.memory === 'number' ? options.config.memory : undefined)
        const memoryPercent = configuredMemory === undefined ? 25 : Number(configuredMemory)
        if (!Number.isFinite(memoryPercent) || memoryPercent < 0 || memoryPercent > 100)
            throw new Error('memoryPercent must be between 0 and 100')
        return new Index({ config, tree, planner, crud, disk, persistence, server: options.server, memoryPercent, mode: options.mode ?? options.config?.mode ?? 'adaptive' })
    }

    #server
    #telemetryListener
    #telemetryTimestamps = new Map()
    #memoryQueue = Promise.resolve()
    #diskFirstQueue = Promise.resolve()
    #diskQueue = Promise.resolve()
    #diskError
    #flushTimer

    constructor({ config, tree, planner, crud, disk, persistence, server = {}, memoryPercent = 25, mode = 'adaptive' }) {
        this.initialConfig = config
        this.tree = tree
        this.planner = planner
        this.crud = crud
        this.disk = disk
        this.persistence = persistence
        this.mode = mode
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
            shedCycles: 0,
            branchesShed: 0,
            leavesShed: 0,
            diskFirst: false,
            diskFirstActivations: 0,
            shedError: undefined,
            lastShed: undefined
        }
        this.memoryPolicy = this.memory

        const primary = server.isPrimary ?? (server.isWorker === true ? false : true)
        if (primary && typeof server.on === 'function') {
            this.#telemetryListener = message => this.#onTelemetry(message)
            server.on('telemetry', this.#telemetryListener)
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

        const diskFirst = memory.diskFirst
            ? pressure >= diskFirstPressure - memoryHysteresis
            : pressure >= diskFirstPressure
        if (diskFirst !== memory.diskFirst) {
            try {
                this.tree.setDiskFirst(diskFirst)
                memory.diskFirst = diskFirst
                if (diskFirst) memory.diskFirstActivations++
            } catch (error) {
                memory.shedError = error
            }
        }

        const sheds = Math.max(0, stage - previousStage)
        if (!sheds || memory.shedError) return
        this.#memoryQueue = this.#memoryQueue.then(async () => {
            for (let count = 0; count < sheds; count++) {
                memory.lastShed = await this.tree.shed()
                memory.shedCycles++
                memory.branchesShed += memory.lastShed?.branches?.count ?? 0
                memory.leavesShed += memory.lastShed?.leaves?.count ?? 0
            }
        }).catch(error => { memory.shedError = error })
    }

    get config() { return this.tree?.config ?? structuredClone(this.initialConfig) }

    get disk() { return this.tree?.disk }
    set disk(handler) { if (this.tree) this.tree.disk = handler }

    async send(request) {
        if (!this.tree.diskFirst) {
            const response = await this.crud.send(request)
            const operation = String(request?.method ?? '').split('.')[1]
            if (operation !== 'read' && response?.success !== false) {
                if (this.#flushTimer === undefined) {
                    this.#flushTimer = setTimeout(() => {
                        this.#flushTimer = undefined
                        this.#diskQueue = this.#diskQueue.then(() => this.tree.flushLocal()).catch(error => { this.#diskError = error })
                    }, 0)
                }
            }
            return response
        }
        const task = this.#diskFirstQueue.then(async () => {
            await this.flushMemory()
            const result = await this.crud.send(request)
            const response = snapshotResponse(request, result)
            await this.tree.flushLocal()
            while ((await this.tree.shed()).count > 0) {}
            return response
        })
        this.#diskFirstQueue = task.then(() => undefined, () => undefined)
        return await task
    }

    async flushIndex() { return await this.tree?.flushIndex?.() }

    async flushLocal() {
        if (this.#flushTimer !== undefined) {
            clearTimeout(this.#flushTimer)
            this.#flushTimer = undefined
        }
        await this.#diskQueue
        if (this.#diskError) throw this.#diskError
        return await this.tree?.flushLocal?.()
    }

    get pendingIndexCount() { return this.tree?.pendingIndexCount ?? 0 }

    async flushDisk() { return await this.flushLocal() }

    async persist() { return await this.persistence.persist() }

    async flushMemory() {
        await this.#memoryQueue
        if (this.memory.shedError) throw this.memory.shedError
        return this.memory.lastShed
    }

    async close() {
        if (this.#telemetryListener) {
            if (typeof this.#server.off === 'function') this.#server.off('telemetry', this.#telemetryListener)
            else this.#server.removeListener?.('telemetry', this.#telemetryListener)
            this.#telemetryListener = undefined
        }
        await this.flushMemory()
        await this.#diskFirstQueue
        await this.flushLocal()
    }
}

export async function createIndex(options) { return await Index.create(options) }

export { Tree, createTree, createConfiguration, defaultConfiguration }
export { createPlatformDisk, createStorageDisk, requestDisk } from './disk/index.js'
export { CRUD, createCRUD } from './crud/index.js'
export { QueryPlanner, planQuery } from './query-planner/index.js'
export { Persistence } from './persistence/index.js'

export default createDB
