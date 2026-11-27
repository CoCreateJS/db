import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import cluster from 'node:cluster'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { availableParallelism, cpus, freemem, totalmem, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import Disk from '@cocreate/disk'
import IPC from '@cocreate/cluster/src/send/ipc.js'
import DB from '../src/index.js'
import { databaseRuntimes } from '../src/runtime.js'
import { createBenchmarkRecord } from '../test/fixtures/lifecycle.mjs'
import { createSystemBlueprint, createSystemRecord, SYSTEM_FIXTURE_VERSION, hashSystemGroups } from '../test/fixtures/system-workload.mjs'

function createDiskTracker() {
    const tracker = { started: 0, completed: 0, failed: 0, inFlight: 0, bytesWritten: 0, byKindAction: {} }
    return {
        snapshot() { return { ...tracker, byKindAction: { ...tracker.byKindAction }, outstanding: tracker.started - tracker.completed - tracker.failed } },
        async execute(adapter, request) {
            const action = request.operation
            const tracked = typeof action === 'string'
            const key = `${request.kind ?? 'unknown'}.${action ?? 'unknown'}`
            if (tracked) {
                tracker.started++
                tracker.inFlight++
                tracker.byKindAction[key] = (tracker.byKindAction[key] ?? 0) + 1
                if (action === 'write') tracker.bytesWritten += Buffer.byteLength(typeof request.data === 'string' ? request.data : JSON.stringify(request.data ?? null))
            }
            try {
                const value = await adapter.execute(request)
                if (tracked) tracker.completed++
                return value
            } catch (error) {
                if (tracked) tracker.failed++
                throw error
            } finally { if (tracked) tracker.inFlight-- }
        }
    }
}

function readHostCpu() {
    const cpu = readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number)
    const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = cpu
    return { total: user + nice + system + idle + iowait + irq + softirq + steal,
        busy: user + nice + system + irq + softirq + steal, iowait }
}
function readHostMemory() {
    const rows = Object.fromEntries(readFileSync('/proc/meminfo', 'utf8').split('\n').map(line => {
        const match = line.match(/^([^:]+):\s+(\d+) kB$/)
        return match ? [match[1], Number(match[2]) * 1024] : []
    }))
    const totalBytes = rows.MemTotal ?? totalmem()
    const availableBytes = rows.MemAvailable ?? freemem()
    return { totalBytes, availableBytes, usedBytes: totalBytes - availableBytes,
        usedPercent: totalBytes ? (totalBytes - availableBytes) / totalBytes * 100 : null }
}

const percentile = (values, fraction) => {
    const sorted = [...values].sort((a, b) => a - b)
    return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] : null
}
const latencyStats = values => {
    let sum = 0, min = Infinity, max = -Infinity
    for (const value of values) { sum += value; min = Math.min(min, value); max = Math.max(max, value) }
    return { count: values.length, meanMs: values.length ? sum / values.length : null,
        p50Ms: percentile(values, 0.50), p95Ms: percentile(values, 0.95), p99Ms: percentile(values, 0.99),
        minMs: values.length ? min : null, maxMs: values.length ? max : null }
}

function server() {
    const server = new EventEmitter()
    server.id = 'db-orchestrator-test'
    server.isPrimary = cluster.isPrimary
    server.isWorker = cluster.isWorker
    server.workerId = cluster.isWorker ? Number(process.env.WORKER_ID) : null
    server.workers = new Map()
    server.workers.awareness = new Map()
    server.emitAsync = async (event, payload) => {
        let response = payload
        for (const handler of server.listeners(event)) response = await handler(payload)
        return response
    }
    server.send = IPC.init(server, new Map())
    return server
}

let readDiskSnapshot = () => null
function createCpuSampler(intervalMs = 1000) {
    let startedAt, previousAt, previousCpu, timer
    const samples = []
    const eventLoop = monitorEventLoopDelay({ resolution: 20 })
    const collect = () => {
        if (!previousCpu) return
        const now = performance.now()
        const elapsedMs = now - previousAt
        const cpu = process.cpuUsage(previousCpu)
        samples.push({ elapsedMs: now - startedAt, intervalMs: elapsedMs, userMicros: cpu.user,
            systemMicros: cpu.system, utilizationPercent: (cpu.user + cpu.system) / (elapsedMs * 1000) * 100,
            rssBytes: process.memoryUsage().rss, heapUsedBytes: process.memoryUsage().heapUsed,
            externalBytes: process.memoryUsage().external, disk: readDiskSnapshot() })
        previousAt = now
        previousCpu = process.cpuUsage()
    }
    return {
        start() {
            clearInterval(timer)
            samples.length = 0
            eventLoop.reset()
            eventLoop.enable()
            startedAt = previousAt = performance.now()
            previousCpu = process.cpuUsage()
            timer = setInterval(collect, intervalMs)
            timer.unref()
        },
        stop() {
            clearInterval(timer)
            collect()
            eventLoop.disable()
            const elapsedMs = samples.at(-1)?.elapsedMs ?? 0
            const userMicros = samples.reduce((sum, sample) => sum + sample.userMicros, 0)
            const systemMicros = samples.reduce((sum, sample) => sum + sample.systemMicros, 0)
            return { elapsedMs, intervalMs, userMs: userMicros / 1000, systemMs: systemMicros / 1000,
                averageUtilizationPercent: elapsedMs ? (userMicros + systemMicros) / (elapsedMs * 1000) * 100 : 0,
                peakUtilizationPercent: Math.max(0, ...samples.map(sample => sample.utilizationPercent)),
                eventLoopDelay: { meanMs: Number.isFinite(eventLoop.mean) ? eventLoop.mean / 1e6 : null,
                    p95Ms: eventLoop.percentile(95) / 1e6, p99Ms: eventLoop.percentile(99) / 1e6,
                    maxMs: eventLoop.max / 1e6 }, samples }
        }
    }
}

const cpuSampler = createCpuSampler(1000)

if (cluster.isWorker) {
    const host = server()
    let leafReads = 0, held, release
    const diskTracker = createDiskTracker()
    readDiskSnapshot = () => diskTracker.snapshot()
    const adapter = await Disk.init({ directory: process.env.DB_DIRECTORY })
    const disk = { execute: request => diskTracker.execute(adapter, request) }
    const execute = disk.execute.bind(disk)
    disk.execute = async request => {
        const value = await execute(request)
        if (request.operation === 'read' && request.path?.includes('/leaves/') && value !== undefined) leafReads++
        return value
    }
    const persistence = { async execute(request) {
        if (request.operation === 'read') return undefined
        if (request.kind === 'leaf' && request.uuid === held) await new Promise(resolve => { release = resolve })
        return request
    } }
    const db = await DB.init(host, { prompt: false, disk, persistence, size: 64 })
    const runtime = databaseRuntimes.get(db)
    host.on('test.measure.start', message => { cpuSampler.start(); return { uuid: message.uuid, result: true } })
    host.on('test.measure.stop', message => ({ uuid: message.uuid, result: cpuSampler.stop() }))
    host.on('test.inspect', message => ({ uuid: message.uuid, result: {
        ...runtime.trees.status(), leafReads, pid: process.pid, memory: process.memoryUsage(), disk: diskTracker.snapshot(),
        organizations: [...runtime.trees.organizations.keys()]
    } }))
    host.on('test.rank', message => {
        for (const tables of runtime.trees.organizations.values()) for (const tree of tables.values())
            tree.weight = message.weights[tree.uuid] ?? 1000
        return { uuid: message.uuid, result: true }
    })
    host.on('test.hold', message => { held = message.leaf; return { uuid: message.uuid, result: true } })
    host.on('test.release', message => { held = undefined; release?.(); return { uuid: message.uuid, result: true } })
    host.on('test.client', async message => ({ uuid: message.uuid, result: await db.send(message.request) }))
    host.on('test.stop', async message => { await runtime.close(); return { uuid: message.uuid, result: true } })
    await host.send({ method: 'test.ready', primary: true, server: host.id, broadcast: false })
} else {
    const count = Number(process.env.DB_RECORDS ?? 80)
    const workers = Number(process.env.DB_WORKERS ?? 2)
    const groupCount = Number(process.env.DB_GROUPS ?? 4)
    const organizationCount = Number(process.env.DB_ORGANIZATIONS ?? 1)
    const systemMode = process.env.DB_SYSTEM_BENCHMARK === '1'
    assert.ok(Number.isSafeInteger(organizationCount) && organizationCount >= 1 && organizationCount <= groupCount, 'DB_ORGANIZATIONS must be between one and DB_GROUPS')
    assert.ok(Number.isSafeInteger(groupCount) && groupCount >= 4, 'DB_GROUPS must be at least four')
    assert.equal(groupCount % organizationCount, 0, 'DB_GROUPS must be divisible by DB_ORGANIZATIONS')
    assert.ok(Number.isSafeInteger(count) && count >= groupCount && count % groupCount === 0, 'DB_RECORDS must be divisible by DB_GROUPS')
    assert.ok(Number.isSafeInteger(workers) && workers >= 1 && workers <= 16, 'Fixture supports one to sixteen workers')
    const ownsDirectory = !process.env.DB_DIRECTORY
    const directory = process.env.DB_DIRECTORY ?? await mkdtemp(join(tmpdir(), 'cocreate-worker-db-'))
    const host = server()
    const primaryDiskTracker = createDiskTracker()
    readDiskSnapshot = () => primaryDiskTracker.snapshot()
    let hostCpuPrevious = readHostCpu()
    let hostCpuStartedAt = performance.now()
    let hostCpuPreviousAt = hostCpuStartedAt
    const hostResourceSamples = []
    let hostResourceTimer
    const sampleHostResources = () => {
        const now = performance.now()
        const cpu = readHostCpu()
        const totalTicks = cpu.total - hostCpuPrevious.total
        hostResourceSamples.push({ elapsedMs: now - hostCpuStartedAt, intervalMs: now - hostCpuPreviousAt,
            totalCpuTicks: totalTicks, busyCpuTicks: cpu.busy - hostCpuPrevious.busy, iowaitCpuTicks: cpu.iowait - hostCpuPrevious.iowait,
            hostBusyCpuPercent: totalTicks > 0 ? 100 * (cpu.busy - hostCpuPrevious.busy) / totalTicks : null,
            hostIowaitPercent: totalTicks > 0 ? 100 * (cpu.iowait - hostCpuPrevious.iowait) / totalTicks : null,
            hostMemory: readHostMemory(),
            primary: { rssBytes: process.memoryUsage().rss, heapUsedBytes: process.memoryUsage().heapUsed,
                externalBytes: process.memoryUsage().external }, disk: primaryDiskTracker.snapshot() })
        hostCpuPrevious = cpu
        hostCpuPreviousAt = now
    }
    let readyCount = 0, resolveReady
    const ready = new Promise(resolve => { resolveReady = resolve })
    host.on('test.ready', message => {
        if (++readyCount === workers) resolveReady()
        return { uuid: message.uuid, result: true }
    })
    cluster.setupPrimary({ exec: fileURLToPath(import.meta.url), args: [], serialization: 'advanced' })
    const children = []
    const initStart = performance.now()
    for (let id = 1; id <= workers; id++) {
        const worker = cluster.fork({ WORKER_ID: String(id), DB_DIRECTORY: directory })
        children.push(worker)
        host.workers.set(id, { id, process: worker })
    }
    const scope = { storage: 'test', database: 'app' }
    const request = async (worker, method, extra = {}) => {
        const response = await host.send({ method, worker, server: host.id, primary: false, broadcast: false, ...extra })
        if (response.success === false || response.error) throw new Error(response.error)
        return response.result
    }
    let db, runtime
    const diagnostics = []
    let systemResultSaved = false
    try {
        await ready
        const adapter = await Disk.init({ directory })
        const disk = { execute: request => primaryDiskTracker.execute(adapter, request) }
        db = await DB.init(host, { prompt: false, disk, size: 64 })
        runtime = databaseRuntimes.get(db)
        const initializationMs = performance.now() - initStart
        const organizationIds = Array.from({ length: organizationCount }, (_, index) => organizationCount === 1
            ? 'worker-org' : (index + 1).toString(16).padStart(24, '0'))
        const groups = Array.from({ length: groupCount }, (_, group) => ({ ...scope,
            organization_id: organizationIds[group % organizationCount],
            array: `table-${Math.floor(group / organizationCount)}` }))
        const arraysPerOrganization = groupCount / organizationCount
        const values = groups.map(() => [])
        const fixtureGenerationStart = performance.now()
        const makeRecord = (rank, group) => systemMode
            ? { ...createSystemRecord({ rank, organizationId: groups[group].organization_id, arrayIndex: group,
                arrayName: groups[group].array, totalRecords: count }), table: group }
            : { ...createBenchmarkRecord(rank, count, groups[group].organization_id), table: group }
        if (process.env.DB_RANDOMIZE_ARRAYS === '1' && arraysPerOrganization > 1) {
            const recordsPerOrganization = count / organizationCount
            const recordsPerArray = count / groupCount
            for (let organization = 0; organization < organizationCount; organization++) {
                const ranks = Array.from({ length: recordsPerOrganization }, (_, rank) => rank)
                let state = (0x9e3779b9 ^ (organization + 1)) >>> 0
                const random = () => {
                    state ^= state << 13; state ^= state >>> 17; state ^= state << 5
                    return state >>> 0
                }
                for (let i = ranks.length - 1; i > 0; i--) {
                    const j = random() % (i + 1)
                    ;[ranks[i], ranks[j]] = [ranks[j], ranks[i]]
                }
                for (let position = 0; position < recordsPerOrganization; position++) {
                    const array = Math.floor(position / recordsPerArray)
                    const group = array * organizationCount + organization
                    const rank = organization * recordsPerOrganization + ranks[position]
                    values[group].push(makeRecord(rank, group))
                }
            }
        } else {
            for (let group = 0; group < groupCount; group++) {
                values[group] = Array.from({ length: count / groupCount }, (_, rank) => makeRecord(group * count / groupCount + rank, group))
            }
        }
        const fixtureGenerationMs = performance.now() - fixtureGenerationStart
        const fixtureDigest = systemMode ? undefined : createHash('sha256').update('[')
        let fixtureHash
        if (systemMode) fixtureHash = hashSystemGroups(values)
        else {
            values.forEach((group, groupIndex) => {
                if (groupIndex) fixtureDigest.update(',')
                fixtureDigest.update('[')
                group.forEach((record, recordIndex) => {
                    if (recordIndex) fixtureDigest.update(',')
                    fixtureDigest.update(JSON.stringify(record))
                })
                fixtureDigest.update(']')
            })
            fixtureHash = fixtureDigest.update(']').digest('hex')
        }
        const ownerships = await Promise.all(organizationIds.map(id => db.organizations.get(id)))
        const ownerByUuid = () => new Map(ownerships.flatMap(ownership => [...ownership.owners]))
        await Promise.all([...host.workers.keys()].map(worker => request(worker, 'test.measure.start')))
        cpuSampler.start()
        const start = performance.now()
        hostCpuStartedAt = start
        hostCpuPrevious = readHostCpu()
        hostCpuPreviousAt = start
        hostResourceTimer = setInterval(sampleHostResources, 1000)
        const parents = []
        const createAckLatencies = []
        let createRequestsStarted = 0, createRequestsAcknowledged = 0
        let createRecordsAcknowledged = 0
        let progressPhase = 'create-acknowledgement'
        let progressCounts = { create: { started: 0, acknowledged: 0, records: 0 } }
        const systemProgressSamples = []
        let progressSampling = false
        const systemProgressTimer = systemMode ? setInterval(async () => {
            if (progressSampling) return
            progressSampling = true
            try {
                const status = await runtime.status()
                const workersNow = await Promise.all([...host.workers.keys()].map(async workerId => ({
                    workerId, ...(await request(workerId, 'test.inspect'))
                })))
                const diskRows = [primaryDiskTracker.snapshot(), ...workersNow.map(row => row.disk)]
                const disk = { started: 0, completed: 0, failed: 0, inFlight: 0, bytesWritten: 0, byKindAction: {} }
                for (const row of diskRows) if (row) {
                    for (const key of ['started', 'completed', 'failed', 'inFlight', 'bytesWritten']) disk[key] += row[key] ?? 0
                    for (const [key, value] of Object.entries(row.byKindAction ?? {})) disk.byKindAction[key] = (disk.byKindAction[key] ?? 0) + value
                }
                const sample = { elapsedMs: performance.now() - start, phase: progressPhase, operations: structuredClone(progressCounts),
                    pendingIndexCount: status.pendingIndexCount, pendingDiskCount: status.pendingDiskCount, disk,
                    hostMemory: readHostMemory(), primaryMemory: process.memoryUsage(),
                    workerMemory: workersNow.map(row => ({ workerId: row.workerId, memory: row.memory })) }
                systemProgressSamples.push(sample)
                console.log(`SYSTEM_PROGRESS ${JSON.stringify(sample)}`)
            } catch (error) { console.warn(`SYSTEM_PROGRESS_ERROR ${error.message}`) }
            finally { progressSampling = false }
        }, 5000) : null
        for (let group = 0; group < groups.length; group++) {
            const before = performance.now()
            createRequestsStarted++
            progressCounts.create = { started: createRequestsStarted, acknowledged: createRequestsAcknowledged, records: createRecordsAcknowledged }
            const created = await db.send({ ...groups[group], method: 'object.create', object: values[group].slice(0, 1) })
            createAckLatencies.push(performance.now() - before)
            assert.equal(created.success, true, created.error?.join('; '))
            createRequestsAcknowledged++
            createRecordsAcknowledged += created.object.length
            progressCounts.create = { started: createRequestsStarted, acknowledged: createRequestsAcknowledged, records: createRecordsAcknowledged }
            parents.push(created.object[0].parent)
        }
        const fixtureReady = performance.now()
        const acknowledgementStart = performance.now()
        await Promise.all(groups.map(async (group, number) => {
            for (let offset = 1; offset < values[number].length; offset += 1000) {
                const before = performance.now()
                createRequestsStarted++
                progressCounts.create = { started: createRequestsStarted, acknowledged: createRequestsAcknowledged, records: createRecordsAcknowledged }
                const response = await db.send({ ...group, method: 'object.create', object: values[number].slice(offset, offset + 1000) })
                createAckLatencies.push(performance.now() - before)
                assert.equal(response.success, true, response.error?.join('; '))
                createRequestsAcknowledged++
                createRecordsAcknowledged += response.object.length
                progressCounts.create = { started: createRequestsStarted, acknowledged: createRequestsAcknowledged, records: createRecordsAcknowledged }
            }
        }))
        const acknowledgementMs = fixtureReady - start + performance.now() - acknowledgementStart
        const createAckWallMs = performance.now() - start
        async function idle({ storage = true } = {}) {
            const timeout = Number(process.env.DB_INDEX_TIMEOUT_MS ?? 1800000)
            const deadline = Date.now() + timeout
            let nextReport = Date.now() + 15000
            let pending = await runtime.status()
            while (pending.pendingIndexCount || storage && pending.pendingDiskCount) {
                if (Date.now() > deadline) throw new Error(`Worker queues did not finish within ${timeout}ms`)
                if (Date.now() >= nextReport) {
                    console.log(JSON.stringify({ phase: 'queue-drain', pendingIndexCount: pending.pendingIndexCount, pendingDiskCount: pending.pendingDiskCount,
                        elapsedMs: timeout - (deadline - Date.now()) }))
                    nextReport = Date.now() + 15000
                }
                await new Promise(resolve => setTimeout(resolve, 20))
                pending = await runtime.status()
            }
        }
        await idle({ storage: false })
        const createAndIndexMs = performance.now() - start
        const pendingDiskAtIndexReady = (await runtime.status()).pendingDiskCount
        let createAndStorageMs = null
        let primaryCpu = null
        let workerCpu = null
        if (!systemMode) {
            await idle()
            createAndStorageMs = performance.now() - start
            primaryCpu = cpuSampler.stop()
            workerCpu = await Promise.all([...host.workers.keys()].map(async workerId => ({ workerId,
                ...await request(workerId, 'test.measure.stop') })))
        }
        assert.equal(runtime.trees.organizations.size, 0, 'orchestrator must never create a local Tree')
        const owners = ownerByUuid()
        const allWorkerTreeCounts = [...owners.values()].reduce((counts, worker) => {
            counts[worker] = (counts[worker] ?? 0) + 1
            return counts
        }, {})
        const dataWorkerCounts = parents.reduce((counts, uuid) => {
            const worker = owners.get(uuid)
            counts[worker] = (counts[worker] ?? 0) + 1
            return counts
        }, {})
        console.log(JSON.stringify({ phase: 'tree-ownership', organizations: organizationCount, arrays: groupCount,
            assignedTrees: parents.length, workerTreeCounts: dataWorkerCounts, allWorkerTreeCounts }))
        assert.equal(Object.keys(allWorkerTreeCounts).length, workers, 'all execution workers must own primary Trees')
        const status = await runtime.status()
        assert.equal(status.pendingIndexCount, 0)
        for (const tree of status.trees) assert.equal(tree.workerId, owners.get(tree.uuid))
        const inspections = await Promise.all([...host.workers.keys()].map(worker => request(worker, 'test.inspect')))
        assert.equal(new Set(inspections.map(worker => worker.pid)).size, workers)
        const primaryMemory = process.memoryUsage()

        let systemMetrics = null
        if (systemMode) {
            const crudOperations = process.env.DB_CRUD_OPERATIONS === 'all'
                ? count : Number(process.env.DB_CRUD_OPERATIONS ?? Math.min(10000, count))
            const crudConcurrency = Number(process.env.DB_CRUD_CONCURRENCY ?? 32)
            const mixedDurationMs = Number(process.env.DB_MIXED_MS ?? 10000)
            const mixedConcurrency = Number(process.env.DB_MIXED_CONCURRENCY ?? 8)
            assert.ok(Number.isSafeInteger(crudOperations) && crudOperations >= 1 && crudOperations <= count, 'DB_CRUD_OPERATIONS must be all or an integer from 1 to DB_RECORDS')
            assert.ok(Number.isSafeInteger(crudConcurrency) && crudConcurrency >= 1, 'DB_CRUD_CONCURRENCY must be positive')
            assert.ok(Number.isSafeInteger(mixedDurationMs) && mixedDurationMs >= 0, 'DB_MIXED_MS must be non-negative')
            assert.ok(Number.isSafeInteger(mixedConcurrency) && mixedConcurrency >= 1, 'DB_MIXED_CONCURRENCY must be positive')
            const pick = position => {
                const linear = Math.min(count - 1, position)
                const group = linear % groupCount
                const record = values[group][Math.floor(linear / groupCount)]
                return { group, record }
            }
            const aggregateDisk = snapshot => {
                const rows = [snapshot.primaryDisk, ...snapshot.workerDisk.map(row => row.disk)].filter(Boolean)
                const total = { started: 0, completed: 0, failed: 0, inFlight: 0, outstanding: 0, bytesWritten: 0, byKindAction: {} }
                for (const row of rows) {
                    for (const key of ['started', 'completed', 'failed', 'inFlight', 'outstanding', 'bytesWritten']) total[key] += row[key] ?? 0
                    for (const [key, value] of Object.entries(row.byKindAction ?? {})) total.byKindAction[key] = (total.byKindAction[key] ?? 0) + value
                }
                return total
            }
            const resourceSnapshot = async () => {
                const status = await runtime.status()
                const workerDisk = await Promise.all([...host.workers.keys()].map(async workerId => ({
                    workerId, ...(await request(workerId, 'test.inspect'))
                })))
                const snapshot = { pendingIndexCount: status.pendingIndexCount, pendingDiskCount: status.pendingDiskCount,
                    primaryDisk: primaryDiskTracker.snapshot(), workerDisk }
                snapshot.diskTotals = aggregateDisk(snapshot)
                return snapshot
            }
            const diskDelta = (before, after, elapsedMs) => {
                const delta = {}
                for (const key of ['started', 'completed', 'failed', 'bytesWritten']) delta[key] = after.diskTotals[key] - before.diskTotals[key]
                delta.startedOpsPerSecond = elapsedMs > 0 ? delta.started * 1000 / elapsedMs : 0
                delta.completedOpsPerSecond = elapsedMs > 0 ? delta.completed * 1000 / elapsedMs : 0
                delta.bytesWrittenPerSecond = elapsedMs > 0 ? delta.bytesWritten * 1000 / elapsedMs : 0
                delta.byKindAction = {}
                for (const key of new Set([...Object.keys(before.diskTotals.byKindAction), ...Object.keys(after.diskTotals.byKindAction)]))
                    delta.byKindAction[key] = (after.diskTotals.byKindAction[key] ?? 0) - (before.diskTotals.byKindAction[key] ?? 0)
                return delta
            }
            const runPointPhase = async (name, method, countToRun, operationMethod = method) => {
                progressPhase = `${method}-acknowledgement`
                progressCounts = { [method]: { started: 0, acknowledged: 0 } }
                const before = await resourceSnapshot()
                const startedAt = performance.now()
                const latencyMs = []
                let acknowledged = 0
                for (let offset = 0; offset < countToRun; offset += crudConcurrency) {
                    const batch = Array.from({ length: Math.min(crudConcurrency, countToRun - offset) }, (_, i) => {
                        const selected = pick(offset + i)
                        return { path: groups[selected.group], selected }
                    })
                    await Promise.all(batch.map(async target => {
                        progressCounts[method].started++
                        const beforeCall = performance.now()
                        const requestObject = method === 'read' || method === 'query' || method === 'delete'
                            ? { uuid: target.selected.record.uuid }
                            : { uuid: target.selected.record.uuid, '$inc.revision': 1 }
                        const query = method === 'query' ? { filter: { query: { rank: target.selected.record.rank } } }
                            : { object: requestObject }
                        const response = await db.send({ ...target.path,
                            method: operationMethod === 'query' ? 'object.read' : `object.${operationMethod}`, ...query })
                        latencyMs.push(performance.now() - beforeCall)
                        assert.equal(response.success, true, response.error?.join('; '))
                        assert.equal(response.object.length, 1, `${method} must affect exactly one record`)
                        acknowledged++
                        progressCounts[method].acknowledged = acknowledged
                    }))
                }
                const acknowledgementWallMs = performance.now() - startedAt
                const afterAcknowledgement = await resourceSnapshot()
                let indexDrainMs = 0
                let afterIndexDrain = afterAcknowledgement
                if (method === 'update' || method === 'delete') {
                    progressPhase = `${method}-index-drain`
                    const drainStart = performance.now()
                    await idle({ storage: false })
                    indexDrainMs = performance.now() - drainStart
                    afterIndexDrain = await resourceSnapshot()
                }
                const stats = latencyStats(latencyMs)
                return { name, requestedOperations: countToRun, acknowledgedOperations: acknowledged,
                    acknowledgementWallMs, operationsPerSecond: acknowledgementWallMs ? acknowledged * 1000 / acknowledgementWallMs : 0,
                    latency: stats, indexDrainMs,
                    queuesBefore: { pendingIndexCount: before.pendingIndexCount, pendingDiskCount: before.pendingDiskCount },
                    queuesAfterAcknowledgement: { pendingIndexCount: afterAcknowledgement.pendingIndexCount, pendingDiskCount: afterAcknowledgement.pendingDiskCount },
                    queuesAfterIndexDrain: { pendingIndexCount: afterIndexDrain.pendingIndexCount, pendingDiskCount: afterIndexDrain.pendingDiskCount },
                    diskDuringAcknowledgement: diskDelta(before, afterAcknowledgement, acknowledgementWallMs),
                    diskDuringIndexDrain: indexDrainMs ? diskDelta(afterAcknowledgement, afterIndexDrain, indexDrainMs) : null,
                    workerDiskSnapshotAtEnd: afterIndexDrain.workerDisk.map(row => ({ workerId: row.workerId, disk: row.disk })) }
            }
            const readPhase = await runPointPhase('read', 'read', crudOperations)
            const indexedReadPhase = await runPointPhase('indexed-read', 'query', crudOperations, 'query')
            const updatePhase = await runPointPhase('update', 'update', crudOperations)
            const deletePhase = await runPointPhase('delete', 'delete', crudOperations)

            let mixed = { status: 'not-run', reason: 'no disjoint records remain for the mixed phase' }
            const mixedPoolSize = Math.floor((count - crudOperations) / 3)
            if (mixedDurationMs > 0 && mixedPoolSize > 0) {
                progressPhase = 'mixed-crud'
                progressCounts = { create: { started: 0, acknowledged: 0 }, read: { started: 0, acknowledged: 0 },
                    update: { started: 0, acknowledged: 0 }, delete: { started: 0, acknowledged: 0 } }
                const before = await resourceSnapshot()
                const mixedStartedAt = performance.now()
                const deadline = mixedStartedAt + mixedDurationMs
                const byType = { create: [], read: [], update: [], delete: [] }
                const countsByType = { create: 0, read: 0, update: 0, delete: 0 }
                let sequence = 0
                let mixedFixtureGenerationMs = 0
                const mixedRequest = async n => {
                    const type = ['create', 'read', 'update', 'delete'][n % 4]
                    let target
                    if (type === 'create') {
                        const group = n % groupCount
                        const fixtureStart = performance.now()
                        const record = systemMode
                            ? createSystemRecord({ rank: count + n, organizationId: groups[group].organization_id,
                                arrayIndex: group, arrayName: groups[group].array, totalRecords: count + mixedDurationMs * mixedConcurrency })
                            : { ...createBenchmarkRecord(count + n, count + mixedDurationMs * mixedConcurrency, groups[group].organization_id), table: group }
                        mixedFixtureGenerationMs += performance.now() - fixtureStart
                        target = { ...groups[group], object: record }
                    } else {
                        const slot = Math.floor(n / 4) % mixedPoolSize
                        const poolOffset = crudOperations + slot * 3 + ({ read: 0, update: 1, delete: 2 })[type]
                        const linear = Math.min(count - 1, poolOffset)
                        const group = linear % groupCount
                        const record = values[group][Math.floor(linear / groupCount)]
                        const object = type === 'read' || type === 'delete' ? { uuid: record.uuid }
                            : { uuid: record.uuid, '$inc.revision': 1 }
                        target = { ...groups[group], object }
                    }
                    const callStart = performance.now()
                    progressCounts[type].started++
                    const response = await db.send({ ...target, method: `object.${type}` })
                    const latency = performance.now() - callStart
                    assert.equal(response.success, true, response.error?.join('; '))
                    assert.equal(response.object.length, 1, `mixed ${type} must affect exactly one record`)
                    byType[type].push(latency)
                    countsByType[type]++
                    progressCounts[type].acknowledged = countsByType[type]
                }
                while (performance.now() < deadline) {
                    const batch = Array.from({ length: mixedConcurrency }, (_, i) => sequence + i)
                    await Promise.all(batch.map(mixedRequest))
                    sequence += mixedConcurrency
                    if (sequence % (mixedConcurrency * 20) === 0)
                        console.log(JSON.stringify({ phase: 'mixed-crud-progress', elapsedMs: performance.now() - mixedStartedAt,
                            operations: sequence, byType: countsByType }))
                }
                const acknowledgementWallMs = performance.now() - mixedStartedAt
                const afterAcknowledgement = await resourceSnapshot()
                progressPhase = 'mixed-index-drain'
                const indexDrainStart = performance.now()
                await idle({ storage: false })
                const indexDrainMs = performance.now() - indexDrainStart
                const afterIndexDrain = await resourceSnapshot()
                mixed = { status: 'complete', requestedDurationMs: mixedDurationMs, concurrency: mixedConcurrency,
                    acknowledgementWallMs, acknowledgedOperations: sequence,
                    fixtureGenerationMs: mixedFixtureGenerationMs,
                    operationsPerSecond: acknowledgementWallMs ? sequence * 1000 / acknowledgementWallMs : 0,
                    acknowledgedByType: countsByType,
                    latencyByType: Object.fromEntries(Object.entries(byType).map(([key, values]) => [key, latencyStats(values)])),
                    indexDrainMs, queuesBefore: { pendingIndexCount: before.pendingIndexCount, pendingDiskCount: before.pendingDiskCount },
                    queuesAfterAcknowledgement: { pendingIndexCount: afterAcknowledgement.pendingIndexCount, pendingDiskCount: afterAcknowledgement.pendingDiskCount },
                    queuesAfterIndexDrain: { pendingIndexCount: afterIndexDrain.pendingIndexCount, pendingDiskCount: afterIndexDrain.pendingDiskCount },
                    diskDuringAcknowledgement: diskDelta(before, afterAcknowledgement, acknowledgementWallMs),
                    diskDuringIndexDrain: indexDrainMs ? diskDelta(afterAcknowledgement, afterIndexDrain, indexDrainMs) : null }
            }
            const finalStatus = await runtime.status()
            clearInterval(hostResourceTimer)
            clearInterval(systemProgressTimer)
            sampleHostResources()
            primaryCpu = cpuSampler.stop()
            workerCpu = await Promise.all([...host.workers.keys()].map(async workerId => ({ workerId,
                ...await request(workerId, 'test.measure.stop') })))
            const runElapsedMs = performance.now() - start
            const totalAcknowledgedRequests = createRequestsAcknowledged + readPhase.acknowledgedOperations +
                indexedReadPhase.acknowledgedOperations + updatePhase.acknowledgedOperations + deletePhase.acknowledgedOperations + (mixed.acknowledgedOperations ?? 0)
            const totalRecordsAcknowledged = createRecordsAcknowledged + readPhase.acknowledgedOperations +
                indexedReadPhase.acknowledgedOperations + updatePhase.acknowledgedOperations + deletePhase.acknowledgedOperations + (mixed.acknowledgedOperations ?? 0)
            const cpuTickTotals = hostResourceSamples.reduce((sum, sample) => ({
                total: sum.total + sample.totalCpuTicks,
                busy: sum.busy + sample.busyCpuTicks,
                iowait: sum.iowait + sample.iowaitCpuTicks
            }), { total: 0, busy: 0, iowait: 0 })
            const memorySamples = hostResourceSamples.map(sample => sample.hostMemory)
            systemMetrics = {
                fixtureVersion: SYSTEM_FIXTURE_VERSION,
                blueprint: createSystemBlueprint({ organizations: organizationCount, workers, arrays: groupCount, records: count,
                    recordsPerCreateRequest: 1000, crudOperations, mixedDurationMs, mixedConcurrency }),
                fixtureGenerationMs, create: { requestsStarted: createRequestsStarted, requestsAcknowledged: createRequestsAcknowledged,
                    recordsSubmitted: count, recordsAcknowledged: createRecordsAcknowledged, acknowledgementWallMs: createAckWallMs,
                    recordsPerSecond: createAckWallMs ? createRecordsAcknowledged * 1000 / createAckWallMs : 0,
                    requestsPerSecond: createAckWallMs ? createRequestsAcknowledged * 1000 / createAckWallMs : 0,
                    requestLatency: latencyStats(createAckLatencies), indexDrainMs: createAndIndexMs - createAckWallMs,
                    createAndIndexMs, diskQueueItemsAtIndexReady: pendingDiskAtIndexReady },
                crud: { uuidRead: readPhase, indexedRead: indexedReadPhase, update: updatePhase, delete: deletePhase, mixed },
                overall: { elapsedMs: runElapsedMs, acknowledgedRequests: totalAcknowledgedRequests,
                    acknowledgedRecordOperations: totalRecordsAcknowledged,
                    operationsPerSecond: runElapsedMs ? totalAcknowledgedRequests * 1000 / runElapsedMs : 0,
                    recordOperationsPerSecond: runElapsedMs ? totalRecordsAcknowledged * 1000 / runElapsedMs : 0 },
                queueAtEnd: { pendingIndexCount: finalStatus.pendingIndexCount, pendingDiskCount: finalStatus.pendingDiskCount },
                persistence: { status: 'stubbed', measured: false,
                    description: 'The worker fixture uses a test persistence stub; external persistence calls and durable acknowledgement are outside this run.' },
                diskAtEnd: { primary: primaryDiskTracker.snapshot(), workers: (await Promise.all([...host.workers.keys()].map(async workerId => ({
                    workerId, ...(await request(workerId, 'test.inspect'))
                })))).map(row => ({ workerId: row.workerId, disk: row.disk })) },
                hostResources: { logicalCpus: availableParallelism(), cpuModel: cpus()[0]?.model,
                    totalMemoryBytes: totalmem(), averageBusyCpuPercent: cpuTickTotals.total ? 100 * cpuTickTotals.busy / cpuTickTotals.total : null,
                    averageIowaitPercent: cpuTickTotals.total ? 100 * cpuTickTotals.iowait / cpuTickTotals.total : null,
                    peakHostMemoryUsedPercent: Math.max(0, ...memorySamples.map(sample => sample.usedPercent ?? 0)),
                    averageHostMemoryUsedPercent: memorySamples.length ? memorySamples.reduce((sum, sample) => sum + sample.usedPercent, 0) / memorySamples.length : null,
                    samples: hostResourceSamples },
                processResources: { primarySamples: primaryCpu.samples,
                    primaryEventLoopDelay: primaryCpu.eventLoopDelay,
                    workers: workerCpu.map(row => ({ workerId: row.workerId, samples: row.samples,
                        averageUtilizationPercent: row.averageUtilizationPercent, peakUtilizationPercent: row.peakUtilizationPercent,
                        eventLoopDelay: row.eventLoopDelay })) },
                createAndIndexMs, diskQueueItemsAtIndexReady: pendingDiskAtIndexReady,
                progressIntervalMs: 5000, progressSamples: systemProgressSamples,
                stoppedBeforeDiskDrain: true
            }
            diagnostics.push('create acknowledgement/indexing', 'UUID and indexed read/update/delete acknowledgement', 'mixed CRUD throughput',
                'per-process disk I/O and queues', 'host CPU and memory samples')
        } else if (process.env.DB_LOAD_ONLY === '1') {
            diagnostics.push('all organization index queues drained', 'zero primary-local Trees', 'worker ownership captured')
        } else {
        for (let group = 0; group < groups.length; group++) {
            const result = await db.send({ ...groups[group], method: 'object.read', filter: {
                query: { table: group }, sort: [{ key: 'rank', direction: 'desc' }], startingIndex: 2, limit: 3
            } })
            assert.equal(result.success, true, result.error?.join('; '))
            assert.deepEqual(result.object.map(row => row.rank), values[group].slice(-5, -2).map(row => row.rank).reverse())
        }
        if (organizationCount === 1) {
            const { array, ...queryScope } = groups[0]
            const combined = await db.send({ ...queryScope, method: 'object.read', filter: {
                query: { $or: [{ table: 0 }, { table: 3 }] }, sort: [{ key: 'rank', direction: 'desc' }], startingIndex: 2, limit: 5
            } })
            assert.equal(combined.success, true, combined.error?.join('; '))
            assert.deepEqual(combined.object.map(row => row.uuid), values.flat().filter(row => row.table === 0 || row.table === 3)
                .sort((a, b) => b.rank - a.rank).slice(2, 7).map(row => row.uuid))
        }
        const owner = owners.get(parents[0])
        const fromWorker = await request(owner, 'test.client', { request: { ...groups[0], method: 'object.read', object: { uuid: values[0][0].uuid } } })
        assert.equal(fromWorker.object[0].uuid, values[0][0].uuid, 'worker ingress routes through coordinator back to owner')
        const bare = await db.send({ organization_id: groups[1].organization_id, method: 'object.read', object: { uuid: values[1][0].uuid } })
        assert.equal(bare.object[0].uuid, values[1][0].uuid)
        const wrong = await db.send({ ...groups[1], method: 'object.read', object: { uuid: values[0][0].uuid } })
        assert.equal(wrong.object.length, 0)
        const otherOrg = await db.send({ ...groups[0], organization_id: 'other-org', method: 'object.create', object: { uuid: values[0][0].uuid, value: 'isolated' } })
        assert.equal(otherOrg.success, true, otherOrg.error?.join('; '))
        await idle()
        const changed = await db.send({ ...groups[0], method: 'object.update', object: { uuid: values[0][0].uuid, table: 99 } })
        assert.equal(changed.success, true, changed.error?.join('; '))
        await idle()
        assert.equal((await db.send({ ...groups[0], method: 'object.read', filter: { query: { table: 99 } } })).object.length, 1)
        const deleted = await db.send({ ...groups[0], method: 'object.delete', object: { uuid: values[0][0].uuid } })
        assert.equal(deleted.success, true)
        await idle()
        assert.equal((await db.send({ ...groups[0], method: 'object.read', object: { uuid: values[0][0].uuid } })).object.length, 0)

        assert.deepEqual(await ownerships[organizationIds.indexOf(groups[1].organization_id)].prune({ uuid: parents[1] }), { count: 1 })
        assert.equal((await db.send({ ...groups[1], method: 'object.read', filter: { query: { table: 1 }, limit: 3 } })).object.length, 3)

        // Each worker ranks its own engines. The coordinator retains placement.
        for (const worker of host.workers.keys()) {
            const own = parents.filter(uuid => owners.get(uuid) === worker)
            const weights = Object.fromEntries(own.map((uuid, i) => [uuid, i + 10]))
            await request(worker, 'test.rank', { weights })
            const result = await request(worker, 'db.tree', { tree: { operation: 'prune', limit: 1 } })
            assert.equal(result.count, 1)
            const after = await request(worker, 'test.inspect')
            assert.equal(after.trees.some(tree => tree.uuid === own[0]), false)
            assert.equal(owners.get(own[0]), worker)
            const group = parents.indexOf(own[0])
            const beforeReads = after.leafReads
            const restored = await db.send({ ...groups[group], method: 'object.read', filter: {
                query: { table: group }, sort: [{ key: 'rank', direction: 'desc' }], limit: 3
            } })
            assert.equal(restored.object.length, 3)
            assert.equal((await request(worker, 'test.inspect')).leafReads - beforeReads, 3, 'cold read restores only its page')
        }
        await request(owner, 'test.hold', { leaf: values[0][1].uuid })
        const update = await db.send({ ...groups[0], method: 'object.update', object: { uuid: values[0][1].uuid, table: 98 } })
        assert.equal(update.success, true, update.error?.join('; '))
        // Wait until that worker has started the queued cycle, then ask it to prune.
        await new Promise(resolve => setTimeout(resolve, 30))
        const blocked = await request(owner, 'test.inspect')
        assert.equal(blocked.trees.find(tree => tree.uuid === parents[0]).pendingIndexCount, 0)
        assert.ok(blocked.trees.find(tree => tree.uuid === parents[0]).pendingDiskCount > 0)
        const protectedResult = await request(owner, 'db.tree', { tree: { operation: 'prune', organization_id: scope.organization_id, uuid: parents[0] } })
        assert.equal(protectedResult.count, 0)
        host.emit('telemetry', { data: { serverId: host.id, workerId: 0, timestamp: 1, memory: { max: 75 } } })
        await new Promise(resolve => setTimeout(resolve, 30))
        assert.ok((await runtime.status()).trees.some(tree => tree.uuid === parents[0]), 'node pressure cannot remove pending Tree')
        host.emit('telemetry', { data: { serverId: host.id, workerId: 0, timestamp: 2, memory: { max: 50 } } })
        await request(owner, 'test.release')
        await idle()
        assert.ok((await runtime.status()).trees.some(tree => tree.uuid === parents[0]), '50% signal stops removal after pending work completes')
        assert.equal((await db.send({ ...groups[0], method: 'object.read', object: { uuid: values[0][1].uuid } })).object[0].table, 98)
        diagnostics.push('round robin and stable ownership', 'worker ingress and UUID routing', 'query sort and pagination',
            'CRUD and organization isolation', 'worker-local weights', 'pending storage protected', 'cold page hydration', '75/50 pressure signals')
        }
        const result = { status: 'passed', fixture: systemMode ? SYSTEM_FIXTURE_VERSION : `lifecycle v3 plus table field, ${groupCount} arrays`,
            ...(systemMode ? { fixtureVersion: SYSTEM_FIXTURE_VERSION, systemMetrics, fixtureGenerationMs } : {}),
            fixtureHash, records: count, workers,
            organizations: organizationCount, arrays: groupCount, arraysPerOrganization, recordsPerGroup: count / groupCount,
            node: process.version, initializationMs, routingSeedMs: fixtureReady - start, acknowledgementMs, createAndIndexMs, createAndStorageMs, pendingDiskAtIndexReady,
            primaryTreeCount: runtime.trees.organizations.size, ownerAssignments: [...owners], allWorkerTreeCounts,
            dataOwners: parents.map((uuid, group) => ({ uuid, organization_id: groups[group].organization_id, workerId: owners.get(uuid) })),
            workerTreeCounts: dataWorkerCounts, pendingIndexCount: (await runtime.status()).pendingIndexCount, pendingDiskCount: (await runtime.status()).pendingDiskCount,
            primaryMemory, workerMemory: inspections.map(worker => ({ pid: worker.pid, ...worker.memory })),
            cpuSampling: { intervalMs: 1000, primary: primaryCpu, workers: workerCpu }, diagnostics }
        if (process.env.DB_RESULT) await writeFile(process.env.DB_RESULT, JSON.stringify(result, null, 2) + '\n')
        const summary = { status: result.status, records: result.records, workers: result.workers,
            organizations: result.organizations, arrays: result.arrays, recordsPerGroup: result.recordsPerGroup,
            acknowledgementMs: result.acknowledgementMs, createAndIndexMs: result.createAndIndexMs,
            pendingIndexCount: result.pendingIndexCount, pendingDiskCount: result.pendingDiskCount,
            workerTreeCounts: result.workerTreeCounts, allWorkerTreeCounts: result.allWorkerTreeCounts,
            cpuSampling: { primaryAveragePercent: result.cpuSampling.primary.averageUtilizationPercent,
                workers: result.cpuSampling.workers.map(worker => ({ workerId: worker.workerId,
                    averageUtilizationPercent: worker.averageUtilizationPercent,
                    peakUtilizationPercent: worker.peakUtilizationPercent })) } }
        if (!systemMode) Object.assign(summary, { primaryTreeCount: result.primaryTreeCount, dataOwners: result.dataOwners,
            createAndStorageMs: result.createAndStorageMs, pendingDiskAtIndexReady: result.pendingDiskAtIndexReady })
        console.log(JSON.stringify(summary))
        if (systemMode) {
            systemResultSaved = true
        }
    } finally {
        if (systemMode && systemResultSaved) {
            clearInterval(hostResourceTimer)
            const exited = children.map(worker => new Promise(resolve => {
                if (worker.isDead()) resolve()
                else worker.once('exit', resolve)
            }))
            for (const worker of children) if (!worker.isDead()) worker.kill('SIGTERM')
            await Promise.race([Promise.all(exited), new Promise(resolve => setTimeout(resolve, 5000))])
            if (ownsDirectory) await rm(directory, { recursive: true, force: true })
            process.exit(0)
        }
        for (const id of host.workers.keys()) await request(id, 'test.release')
        if (runtime) await runtime.close()
        for (const id of host.workers.keys()) await request(id, 'test.stop')
        await Promise.all(children.map(worker => new Promise(resolve => { worker.once('exit', resolve); worker.disconnect() })))
        if (ownsDirectory) await rm(directory, { recursive: true, force: true })
    }
}
