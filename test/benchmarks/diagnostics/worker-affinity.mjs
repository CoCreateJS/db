import assert from 'node:assert/strict'
import { fork, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { availableParallelism, cpus, totalmem } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { benchmarkUuid, createBenchmarkRecord } from '../../fixtures/lifecycle.mjs'
import { nodeMemory } from '../shared/node-memory.mjs'
import { writeAccounting, storageTables } from '../shared/storage-report.mjs'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const workerScript = fileURLToPath(new URL('../../../test-support/worker-affinity-db.mjs', import.meta.url))
const readOption = (name, environment, fallback) => {
    const flag = process.argv.find(argument => argument.startsWith(`--${name}=`))
    const value = flag?.slice(name.length + 3) ?? process.env[environment] ?? fallback
    return Number(value)
}
const totalRecords = readOption('total-records', 'BENCH_TOTAL_RECORDS', 1_000_000)
const workerCount = readOption('workers', 'BENCH_WORKERS', availableParallelism())
const batchSize = readOption('batch-size', 'BENCH_BATCH_SIZE', 1000)
const diskMode = process.env.BENCH_DISK ?? 'local'
const heapMb = readOption('worker-heap-mb', 'BENCH_WORKER_HEAP_MB', 4096)
if (!Number.isSafeInteger(totalRecords) || totalRecords < 1) throw Error('--total-records must be a positive integer')
if (!Number.isSafeInteger(workerCount) || workerCount < 1 || workerCount > availableParallelism())
    throw Error(`--workers must be between 1 and availableParallelism() (${availableParallelism()})`)
if (workerCount > totalRecords) throw Error('There must be at least one record per worker')
if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw Error('--batch-size must be a positive integer')
if (!['local', 'noop', 'disabled'].includes(diskMode)) throw Error('BENCH_DISK must be local, noop or disabled')
if (!Number.isSafeInteger(heapMb) || heapMb < 512) throw Error('--worker-heap-mb must be an integer of at least 512')

const crudOperations = readOption('crud-operations', 'BENCH_CRUD_OPERATIONS', 10_000)
if (!Number.isSafeInteger(crudOperations) || crudOperations < 0) throw Error('--crud-operations must be a non-negative integer')
const baseRecordsPerWorker = Math.floor(totalRecords / workerCount)
const remainder = totalRecords % workerCount
const assignments = Array.from({ length: workerCount }, (_, offset) => ({
    workerId: offset + 1,
    organizationId: (offset + 1).toString(16).padStart(24, '0'),
    records: baseRecordsPerWorker + (offset < remainder ? 1 : 0)
}))
const maxCrudOperations = Math.min(...assignments.map(assignment => assignment.records))
if (crudOperations > maxCrudOperations)
    throw Error(`--crud-operations must not exceed the smallest worker record count (${maxCrudOperations})`)

const runId = new Date().toISOString().replaceAll(':', '-')
const output = resolve(process.env.BENCH_OUTPUT_DIR ??
    `test/benchmarks/providers/cocreatedb/results/worker-affinity-${totalRecords}-${workerCount}x-${runId}`)
await mkdir(output, { recursive: true })
const result = {
    status: 'running', startedAt: new Date().toISOString(), totalRecords, workerCount,
    organizationCount: workerCount, batchSize, crudOperationsPerOrganization: crudOperations,
    processModel: 'one DB instance and one organization per worker process; benchmark driver has no DB; organization affinity is pinned for the run',
    disk: diskMode === 'local' ? 'local @cocreate/disk adapter enabled' :
        diskMode === 'noop' ? 'no-op adapter; no physical disk I/O' : 'disabled; no local index tier',
    node: process.version,
    host: { architecture: process.arch, logicalCpus: cpus().length, availableParallelism: availableParallelism(), totalMemoryBytes: totalmem() },
    assignments,
    workers: [],
    operations: { sampleCrud: {} }
}

const percentile = (samples, fraction) => {
    if (!samples.length) return null
    const sorted = [...samples].sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]
}
const latencyStats = samples => {
    const totalMs = samples.reduce((total, value) => total + value, 0)
    return { count: samples.length, totalMs, averageMs: samples.length ? totalMs / samples.length : null,
        minMs: samples.length ? samples.reduce((min, value) => Math.min(min, value), Infinity) : null,
        maxMs: samples.length ? samples.reduce((max, value) => Math.max(max, value), -Infinity) : null,
        p50Ms: percentile(samples, 0.50), p95Ms: percentile(samples, 0.95), p99Ms: percentile(samples, 0.99) }
}
function readCpuTicks() {
    try {
        const values = readFileSync('/proc/stat', 'utf8').split('\n', 1)[0].trim().split(/\s+/).slice(1, 9).map(Number)
        const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = values
        return { total: user + nice + system + idle + iowait + irq + softirq + steal,
            busy: user + nice + system + irq + softirq + steal, iowait }
    } catch { return undefined }
}
const cpuSamples = []
const hostMemorySamples = []
let previousCpu, previousCpuAt, cpuTimer
const sampleCpu = () => {
    const current = readCpuTicks()
    if (!current || !previousCpu) { previousCpu = current; previousCpuAt = performance.now(); return }
    const totalTicks = current.total - previousCpu.total
    const busyTicks = current.busy - previousCpu.busy
    const iowaitTicks = current.iowait - previousCpu.iowait
    cpuSamples.push({ elapsedMs: performance.now() - workloadStartedAt,
        busyPercent: totalTicks > 0 ? busyTicks * 100 / totalTicks : null,
        iowaitPercent: totalTicks > 0 ? iowaitTicks * 100 / totalTicks : null })
    hostMemorySamples.push({ elapsedMs: performance.now() - workloadStartedAt, ...nodeMemory() })
    previousCpu = current
    previousCpuAt = performance.now()
}

const currentWorkerMemory = new Map()
const workerPeakMemory = new Map()
const updateWorkerMemory = message => {
    const memory = message.memory
    if (!memory || !Number.isInteger(message.workerId)) return
    const rssBytes = memory.rss
    currentWorkerMemory.set(message.workerId, rssBytes)
    workerPeakMemory.set(message.workerId, Math.max(workerPeakMemory.get(message.workerId) ?? 0,
        message.peakRssBytes ?? rssBytes))
    result.memory ??= { aggregatePeakObservedRssBytes: 0, workers: {} }
    const aggregateRss = [...currentWorkerMemory.values()].reduce((sum, value) => sum + value, 0)
    result.memory.aggregatePeakObservedRssBytes = Math.max(result.memory.aggregatePeakObservedRssBytes, aggregateRss)
    result.memory.workers[message.workerId] = { currentRssBytes: rssBytes,
        peakRssBytes: workerPeakMemory.get(message.workerId), heapUsedBytes: memory.heapUsed }
}

function startWorker(assignment) {
    const child = fork(workerScript, [], {
        cwd: repoRoot,
        env: { ...process.env,
            NODE_OPTIONS: `--max-old-space-size=${heapMb}`,
            BENCH_WORKER_ID: String(assignment.workerId),
            BENCH_ORGANIZATION_ID: assignment.organizationId,
            BENCH_RECORDS_PER_WORKER: String(assignment.records),
            BENCH_DISK: diskMode
        },
        execArgv: [], serialization: 'advanced', stdio: ['ignore', 'ignore', 'inherit', 'ipc']
    })
    let requestNumber = 0
    let readyResolve, readyReject
    const ready = new Promise((resolveReady, rejectReady) => { readyResolve = resolveReady; readyReject = rejectReady })
    const pending = new Map()
    const worker = { ...assignment, child, ready, rpc: undefined }
    const rejectPending = error => {
        for (const operation of pending.values()) { clearTimeout(operation.timer); operation.reject(error) }
        pending.clear()
    }
    child.on('message', message => {
        if (message.event === 'ready') {
            worker.pid = message.pid
            worker.diskDirectory = message.diskDirectory
            worker.readyMessage = message
            updateWorkerMemory({ ...message, workerId: assignment.workerId, peakRssBytes: message.memory?.rss })
            readyResolve(message)
            return
        }
        if (message.event === 'resource') { updateWorkerMemory(message); return }
        const operation = pending.get(message.requestId)
        if (!operation) return
        pending.delete(message.requestId)
        clearTimeout(operation.timer)
        if (message.ok) {
            if (message.value) updateWorkerMemory(message.value)
            operation.resolve(message.value)
        } else operation.reject(Object.assign(new Error(message.error?.message ?? 'Worker request failed'), {
            workerId: assignment.workerId, stack: message.error?.stack
        }))
    })
    child.on('error', error => { readyReject(error); rejectPending(error) })
    child.on('exit', (code, signal) => {
        const error = new Error(`Worker ${assignment.workerId} exited (${code ?? signal})`)
        readyReject(error)
        rejectPending(error)
    })
    worker.rpc = (type, payload = {}) => new Promise((resolveRpc, rejectRpc) => {
        const requestId = `${assignment.workerId}:${++requestNumber}`
        const timeoutMs = type === 'drainIndex' ? Number(process.env.BENCH_INDEX_TIMEOUT_MS ?? 1200000) + 30000 : 120000
        const timer = setTimeout(() => {
            pending.delete(requestId)
            rejectRpc(new Error(`Worker ${assignment.workerId} ${type} request timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        pending.set(requestId, { resolve: resolveRpc, reject: rejectRpc, timer })
        child.send({ requestId, type, ...payload }, error => {
            if (!error) return
            const operation = pending.get(requestId)
            if (!operation) return
            pending.delete(requestId)
            clearTimeout(timer)
            rejectRpc(error)
        })
    })
    return worker
}

const workers = assignments.map(startWorker)
const terminateWorkers = async () => {
    await Promise.all(workers.map(async worker => {
        if (worker.child.exitCode !== null || worker.child.signalCode !== null) return
        if (result.status === 'failed') {
            worker.child.kill('SIGTERM')
            await Promise.race([new Promise(resolveExit => worker.child.once('exit', resolveExit)),
                new Promise(resolveTimeout => setTimeout(() => { worker.child.kill('SIGKILL'); resolveTimeout() }, 5000))])
            return
        }
        try {
            if (result.status === 'passed') await worker.rpc('finishWithoutDiskDrain')
            else await worker.rpc('close')
        } catch { worker.child.kill('SIGTERM') }
        if (worker.child.exitCode === null && worker.child.signalCode === null) {
            await Promise.race([
                new Promise(resolveExit => worker.child.once('exit', resolveExit)),
                new Promise(resolveTimeout => setTimeout(() => { worker.child.kill('SIGKILL'); resolveTimeout() }, 5000))
            ])
        }
        if (worker.diskDirectory) await rm(worker.diskDirectory, { recursive: true, force: true }).catch(() => {})
    }))
}
const runContext = {
    capturedAt: new Date().toISOString(),
    branch: execFileSync('git', ['branch', '--show-current'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
    baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
    dirty: execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' }).trim().length > 0,
    command: `node test/benchmarks/diagnostics/worker-affinity.mjs --workers=${workerCount} --total-records=${totalRecords}`,
    orchestration: 'parent is a load generator only and does not initialize DB; each child initializes its own local DB and owns one organization'
}

let workloadStartedAt = performance.now()
let cpuHostStart, cpuTimerStarted = false
try {
    await Promise.all(workers.map(worker => worker.ready))
    assert.equal(new Set(workers.map(worker => worker.pid)).size, workerCount, 'each organization must have a distinct worker process')
    assert.equal(new Set(workers.map(worker => worker.organizationId)).size, workerCount, 'each worker must have a distinct organization')
    result.initializationMs = Date.now() - new Date(result.startedAt).getTime()
    const roots = new Map(workers.map(worker => [worker.workerId, {
        organization_id: worker.organizationId, storage: 'bench', database: 'app', array: 'records'
    }]))
    const workerResults = new Map(workers.map(worker => [worker.workerId, {
        workerId: worker.workerId, organizationId: worker.organizationId, pid: worker.pid,
        records: worker.records, createAcknowledgementsMs: [], fixtureGenerationMs: 0,
        memoryAtStart: worker.readyMessage?.memory
    }]))
    const bulkLatencies = []
    const bulkStart = performance.now()
    workloadStartedAt = bulkStart
    cpuHostStart = readCpuTicks()
    previousCpu = cpuHostStart
    previousCpuAt = performance.now()
    cpuTimer = setInterval(sampleCpu, 1000)
    cpuTimerStarted = true

    await Promise.all(workers.map(async worker => {
        const stats = workerResults.get(worker.workerId)
        const root = roots.get(worker.workerId)
        const hash = createHash('sha256')
        const workerStart = performance.now()
        for (let offset = 0; offset < worker.records; offset += batchSize) {
            const generationStart = performance.now()
            const records = Array.from({ length: Math.min(batchSize, worker.records - offset) }, (_, index) =>
                createBenchmarkRecord(offset + index, worker.records, worker.organizationId))
            hash.update(JSON.stringify(records))
            stats.fixtureGenerationMs += performance.now() - generationStart
            const before = performance.now()
            const response = await worker.rpc('createBatch', { root, records })
            const acknowledgementMs = performance.now() - before
            stats.createAcknowledgementsMs.push(acknowledgementMs)
            bulkLatencies.push(acknowledgementMs)
            assert.equal(response.count, records.length, `worker ${worker.workerId} acknowledged the batch`)
            if (offset + records.length === worker.records || (offset + records.length) % 10000 === 0)
                console.log(`BENCH_PROGRESS worker=${worker.workerId} organization=${worker.organizationId} acknowledged=${offset + records.length}/${worker.records}`)
        }
        stats.fixtureHash = hash.digest('hex')
        stats.createAcknowledgementWallMs = performance.now() - workerStart
        stats.snapshotAfterAcknowledgement = await worker.rpc('snapshot')
        stats.pendingAfterAcknowledgement = stats.snapshotAfterAcknowledgement.pendingIndexCount
    }))
    const allAcknowledgedAt = performance.now()
    result.bulkCreate = {
        requests: bulkLatencies.length, records: totalRecords,
        acknowledgementWallMs: allAcknowledgedAt - bulkStart,
        fixtureGenerationMs: [...workerResults.values()].reduce((sum, stats) => sum + stats.fixtureGenerationMs, 0),
        acknowledgementWallMsExcludingFixtureGeneration: allAcknowledgedAt - bulkStart -
            [...workerResults.values()].reduce((sum, stats) => sum + stats.fixtureGenerationMs, 0),
        requestsPerSecond: bulkLatencies.length * 1000 / (allAcknowledgedAt - bulkStart),
        recordsPerSecond: totalRecords * 1000 / (allAcknowledgedAt - bulkStart),
        requestLatency: latencyStats(bulkLatencies),
        workers: [...workerResults.values()].map(({ createAcknowledgementsMs, ...stats }) => ({
            ...stats, batchRequestLatency: latencyStats(createAcknowledgementsMs)
        }))
    }
    result.pendingIndexAfterAcknowledgement = [...workerResults.values()].reduce((sum, stats) => sum + stats.pendingAfterAcknowledgement, 0)
    result.pendingDiskAfterAcknowledgement = (await Promise.all(workers.map(worker => worker.rpc('snapshot'))))
        .reduce((sum, snapshot) => sum + snapshot.pendingDiskCount, 0)

    const drainStart = performance.now()
    const drainResults = await Promise.all(workers.map(worker => worker.rpc('drainIndex')))
    result.indexDrainMs = performance.now() - drainStart
    result.createAndIndexMs = performance.now() - bulkStart
    result.pendingIndexAtIndexReady = drainResults.reduce((sum, row) => sum + row.pendingIndexCount, 0)
    result.pendingDiskAtIndexReady = drainResults.reduce((sum, row) => sum + row.pendingDiskCount, 0)
    result.indexDrainByWorker = drainResults.map(row => ({ workerId: row.workerId,
        organizationId: row.organizationId, pendingBeforeDrain: row.pendingBefore,
        pendingIndexAfterDrain: row.pendingIndexCount, pendingDiskAtIndexReady: row.pendingDiskCount,
        drainMs: row.drainMs, processMemory: row.memory, peakRssBytes: row.peakRssBytes,
        dbMemory: row.dbMemory }))
    const sumDisk = rows => rows.reduce((sum, row) => {
        const requests = row.diskRequests ?? {}
        for (const key of ['submittedRequests', 'fulfilledRequests', 'failedRequests', 'outstandingRequests', 'submittedWriteBytes'])
            sum[key] += requests[key] ?? 0
        for (const key of ['submittedRequestsByKind', 'submittedWriteBytesByKind', 'outstandingRequestsByKind', 'supersededRequestsByKind', 'cancelledRequestsByKind', 'failures'])
            for (const [kind, value] of Object.entries(requests[key] ?? {})) sum[key][kind] = (sum[key][kind] ?? 0) + value
        return sum
    }, { submittedRequests: 0, fulfilledRequests: 0, failedRequests: 0, outstandingRequests: 0, submittedWriteBytes: 0,
        submittedRequestsByKind: {}, submittedWriteBytesByKind: {}, outstandingRequestsByKind: {}, supersededRequestsByKind: {}, cancelledRequestsByKind: {}, failures: {} })
    const sumFilesystem = rows => rows.reduce((sum, row) => {
        for (const [key, stats] of Object.entries(row.filesystem ?? {})) {
            const total = sum[key] ??= { startedCalls: 0, payloadBytesStarted: 0, payloadBytesCompleted: 0, completedCalls: 0, failedCalls: 0 }
            for (const metric of Object.keys(total)) total[metric] += stats[metric] ?? 0
        }
        return sum
    }, {})

    result.diskRequestsAtIndexReady = sumDisk(drainResults)
    result.filesystemAtIndexReady = sumFilesystem(drainResults)
    result.diskWriteAccountingAtIndexReady = writeAccounting(result.diskRequestsAtIndexReady, result.filesystemAtIndexReady)

    if (crudOperations > 0) {
    const crudFixtures = new Map(workers.map(worker => [worker.workerId,
        Array.from({ length: crudOperations }, (_, index) => {
            const record = createBenchmarkRecord(worker.records + index, worker.records + crudOperations, worker.organizationId)
            record.group = 'crud-sample'
            return record
        })]))

    const runCrudPhase = async (name, makeRequest, mutating = false) => {
        const pendingBefore = await Promise.all(workers.map(worker => worker.rpc('snapshot')))
        const phaseStart = performance.now()
        const allLatencies = []
        const perWorker = await Promise.all(workers.map(async worker => {
            const latencies = []
            const fixtures = crudFixtures.get(worker.workerId)
            const root = roots.get(worker.workerId)
            const workerStart = performance.now()
            let acknowledgedRecords = 0
            for (let index = 0; index < crudOperations; index++) {
                const before = performance.now()
                const response = await worker.rpc('crud', { request: { ...root, ...makeRequest(fixtures[index], index) } })
                const latency = performance.now() - before
                latencies.push(latency)
                allLatencies.push(latency)
                assert.equal(response.count, 1, `${name} returns one record per request`)
                acknowledgedRecords += response.count
            }
            return { workerId: worker.workerId, organizationId: worker.organizationId,
                requests: crudOperations, records: acknowledgedRecords,
                acknowledgementWallMs: performance.now() - workerStart,
                requestLatency: latencyStats(latencies) }
        }))
        const acknowledgementWallMs = performance.now() - phaseStart
        const pendingAfterAcknowledgement = await Promise.all(workers.map(worker => worker.rpc('snapshot')))
        let indexDrainMs = 0
        let drainResults = []
        if (mutating) {
            const indexStart = performance.now()
            drainResults = await Promise.all(workers.map(worker => worker.rpc('drainIndex')))
            indexDrainMs = performance.now() - indexStart
        }
        const requests = perWorker.reduce((sum, row) => sum + row.requests, 0)
        const records = perWorker.reduce((sum, row) => sum + row.records, 0)
        const acknowledgement = latencyStats(allLatencies)
        result.operations.sampleCrud[name] = {
            requests, records, acknowledgementWallMs,
            requestsPerSecond: requests * 1000 / acknowledgementWallMs,
            recordsPerSecond: records * 1000 / acknowledgementWallMs,
            requestConcurrency: workerCount, perWorkerConcurrency: 1,
            acknowledgement, indexDrainPerformed: mutating, indexDrainMs,
            pendingIndexBefore: pendingBefore.reduce((sum, row) => sum + row.pendingIndexCount, 0),
            pendingIndexAfterAcknowledgement: pendingAfterAcknowledgement.reduce((sum, row) => sum + row.pendingIndexCount, 0),
            pendingDiskAfterAcknowledgement: pendingAfterAcknowledgement.reduce((sum, row) => sum + row.pendingDiskCount, 0),
            pendingIndexAfterDrain: (mutating ? drainResults : pendingAfterAcknowledgement).reduce((sum, row) => sum + row.pendingIndexCount, 0),
            pendingDiskAfterDrain: (mutating ? drainResults : pendingAfterAcknowledgement).reduce((sum, row) => sum + row.pendingDiskCount, 0),
            workers: perWorker.map(row => {
                const before = pendingBefore.find(snapshot => snapshot.workerId === row.workerId)
                const afterAck = pendingAfterAcknowledgement.find(snapshot => snapshot.workerId === row.workerId)
                const afterIndex = drainResults.find(snapshot => snapshot.workerId === row.workerId)
                return { ...row, requestLatency: row.requestLatency,
                    memoryBefore: before?.memory, memoryAfterAcknowledgement: afterAck?.memory,
                    memoryAfterIndexDrain: afterIndex?.memory,
                    pendingDiskBefore: before?.pendingDiskCount,
                    pendingDiskAfterAcknowledgement: afterAck?.pendingDiskCount,
                    pendingDiskAfterIndexDrain: (afterIndex ?? afterAck)?.pendingDiskCount }
            })
        }
        return result.operations.sampleCrud[name]
    }
    const phaseRequest = (record, method, update = false) => ({ method: `object.${method}`,
        object: { uuid: record.uuid, ...(update ? { '$inc.revision': 1 } : {}) } })
    await runCrudPhase('create', record => ({ method: 'object.create', object: record }), true)
    await runCrudPhase('readByUuid', record => phaseRequest(record, 'read'))
    await runCrudPhase('indexedRead', () => ({ method: 'object.read', filter: { query: { group: 'crud-sample' }, limit: 1 } }))
    await runCrudPhase('update', record => phaseRequest(record, 'update', true), true)
    await Promise.all(workers.map(worker => worker.rpc('validate', { root: roots.get(worker.workerId), deleted: false })))
    await runCrudPhase('delete', record => phaseRequest(record, 'delete'), true)
    await Promise.all(workers.map(worker => worker.rpc('validate', { root: roots.get(worker.workerId), deleted: true })))
    const crudPhases = Object.values(result.operations.sampleCrud)
    const sampleRequests = crudPhases.reduce((sum, phase) => sum + phase.requests, 0)
    const sampleRecords = crudPhases.reduce((sum, phase) => sum + phase.records, 0)
    const sampleAckMs = crudPhases.reduce((sum, phase) => sum + phase.acknowledgementWallMs, 0)
    const sampleDrainMs = crudPhases.reduce((sum, phase) => sum + phase.indexDrainMs, 0)
    result.operations.overall = {
        requests: result.bulkCreate.requests + sampleRequests,
        recordOperations: totalRecords + sampleRecords,
        acknowledgementWallMs: result.bulkCreate.acknowledgementWallMs + sampleAckMs,
        indexDrainMs: result.indexDrainMs + sampleDrainMs,
        endToEndMs: result.createAndIndexMs + sampleAckMs + sampleDrainMs,
        requestsPerSecond: (result.bulkCreate.requests + sampleRequests) * 1000 /
            (result.bulkCreate.acknowledgementWallMs + sampleAckMs),
        recordOperationsPerSecond: (totalRecords + sampleRecords) * 1000 /
            (result.bulkCreate.acknowledgementWallMs + sampleAckMs)
    }
    }
    result.finalWorkers = crudOperations > 0
        ? await Promise.all(workers.map(worker => worker.rpc('snapshot')))
        : drainResults
    result.diskRequestsAtEnd = sumDisk(result.finalWorkers)
    result.filesystemAtEnd = sumFilesystem(result.finalWorkers)
    result.diskWriteAccountingAtEnd = writeAccounting(result.diskRequestsAtEnd, result.filesystemAtEnd)
    if (cpuTimerStarted) {
        clearInterval(cpuTimer)
        sampleCpu()
        cpuTimerStarted = false
    }
    result.hostCpu = {
        sampleCount: cpuSamples.length,
        averageBusyPercentAcrossLogicalCpus: cpuSamples.length ? cpuSamples.reduce((sum, row) => sum + row.busyPercent, 0) / cpuSamples.length : null,
        peakBusyPercentAcrossLogicalCpus: cpuSamples.length ? Math.max(...cpuSamples.map(row => row.busyPercent)) : null,
        averageIowaitPercent: cpuSamples.length ? cpuSamples.reduce((sum, row) => sum + row.iowaitPercent, 0) / cpuSamples.length : null,
        samples: cpuSamples
    }
    result.hostMemory = {
        sampleCount: hostMemorySamples.length,
        totalBytes: hostMemorySamples.at(-1)?.total ?? totalmem(),
        averageUsedPercent: hostMemorySamples.length ? hostMemorySamples.reduce((sum, row) => sum + row.max, 0) / hostMemorySamples.length : null,
        peakUsedPercent: hostMemorySamples.length ? Math.max(...hostMemorySamples.map(row => row.max)) : null,
        samples: hostMemorySamples
    }
    result.memory ??= { aggregatePeakObservedRssBytes: 0, workers: {} }
    result.memory.workerPeakRssSumBytes = [...workerPeakMemory.values()].reduce((sum, value) => sum + value, 0)
    result.memory.driver = process.memoryUsage()
    result.telemetry = result.finalWorkers.map(row => ({ workerId: row.workerId,
        organizationId: row.organizationId, dbMemory: row.dbMemory }))
    result.correctness = {
        oneOrganizationPerWorker: true,
        allWorkersUsed: new Set(result.finalWorkers.map(row => row.workerId)).size === workerCount,
        distinctWorkerProcesses: new Set(result.finalWorkers.map(row => row.pid)).size === workerCount,
        allRecordsAcknowledged: result.bulkCreate.records === totalRecords,
        indexReadyOnAllWorkers: result.pendingIndexAtIndexReady === 0,
        crudSamplesPassed: crudOperations > 0 ? true : 'not run; workload ends at index-ready'
    }
    result.status = 'passed'
} catch (error) {
    result.status = 'failed'
    result.failure = { message: error.message, stack: error.stack, workerId: error.workerId }
    process.exitCode = 1
} finally {
    if (cpuTimerStarted) { clearInterval(cpuTimer); sampleCpu() }
    await terminateWorkers()
    result.completedAt = new Date().toISOString()
    result.runContext = runContext
    await writeFile(resolve(output, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
    const rows = result.operations ? [
        ...(result.bulkCreate ? [['bulkCreate', { requests: result.bulkCreate.requests, records: result.bulkCreate.records,
            acknowledgementWallMs: result.bulkCreate.acknowledgementWallMs,
            requestsPerSecond: result.bulkCreate.requestsPerSecond,
            recordsPerSecond: result.bulkCreate.recordsPerSecond,
            acknowledgement: result.bulkCreate.requestLatency, indexDrainMs: result.indexDrainMs ?? 0 }]] : []),
        ...Object.entries(result.operations.sampleCrud),
        ...(result.operations.overall ? [['overall', result.operations.overall]] : [])
    ] : []
    const operationRows = rows.map(([name, row]) => `| ${name} | ${row.requests} | ${row.records ?? row.recordOperations} | ${row.acknowledgementWallMs.toFixed(2)} | ${row.requestsPerSecond.toFixed(1)} | ${(row.recordsPerSecond ?? row.recordOperationsPerSecond).toFixed(1)} | ${row.acknowledgement?.averageMs?.toFixed(3) ?? '-'} | ${row.acknowledgement?.p95Ms?.toFixed(3) ?? '-'} | ${row.indexDrainMs.toFixed(2)} |`).join('\n')
    let report = `# Worker organization affinity benchmark\n\nStatus: ${result.status}. Total records: ${totalRecords.toLocaleString()}; workers and organizations: ${workerCount}; disk mode: ${diskMode}. The benchmark driver has no DB. Each worker process initializes a local DB instance and owns exactly one organization. Work is pinned to that worker for the entire run.\n\n## Assignment\n\n| Worker | Organization | Records | PID |\n| --- | --- | ---: | ---: |\n${assignments.map(row => `| ${row.workerId} | ${row.organizationId} | ${row.records.toLocaleString()} | ${workers.find(worker => worker.workerId === row.workerId)?.pid ?? '-'} |`).join('\n')}\n\n## Throughput and acknowledgements\n\nCRUD request loops run sequentially within each worker and concurrently across workers. Throughput uses host-side IPC acknowledgement wall time. In-memory index catch-up is reported separately. A passed status covers workload correctness; storage can still be pending in the snapshots below. Shutdown drains remaining requests outside these workload timings.\n\n| Operation | Requests | Records / operations | Ack wall (ms) | Requests/s | Records / operations/s | Avg ack (ms) | P95 ack (ms) | In-memory index catch-up (ms) |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n${operationRows}\n\nBulk create → in-memory indexes ready: ${((result.createAndIndexMs ?? 0) / 1000).toFixed(2)} s. In-memory index catch-up after bulk acknowledgement: ${((result.indexDrainMs ?? 0) / 1000).toFixed(2)} s. Pending index items at index-ready: ${result.pendingIndexAtIndexReady ?? 'not reached'}. Outstanding storage requests at index-ready (not unique files): ${result.pendingDiskAtIndexReady ?? 'not sampled'}. Index readiness waits only for the index queue; disk backlog remains an independent measurement.\n\nHost CPU average across ${availableParallelism()} available logical CPUs: ${result.hostCpu?.averageBusyPercentAcrossLogicalCpus?.toFixed(2) ?? 'not sampled'}%. Host memory average used: ${result.hostMemory?.averageUsedPercent?.toFixed(2) ?? 'not sampled'}%; peak sampled used: ${result.hostMemory?.peakUsedPercent?.toFixed(2) ?? 'not sampled'}%. Observed aggregate worker RSS peak: ${((result.memory?.aggregatePeakObservedRssBytes ?? 0) / 1048576).toFixed(1)} MiB. Sum of per-worker peak RSS values: ${((result.memory?.workerPeakRssSumBytes ?? 0) / 1048576).toFixed(1)} MiB; individual peaks may not be simultaneous.\n\nDisk mode note: ${diskMode === 'local' ? 'real local disk adapter attached.' : diskMode === 'noop' ? 'no-op adapter; no physical I/O.' : 'disk adapter disabled; in-memory-only run.'} Correctness: ${JSON.stringify(result.correctness ?? result.failure)}.\n`
    report += `\n## Storage accounting at in-memory index readiness\n\n${storageTables(result.diskWriteAccountingAtIndexReady ?? writeAccounting({}, {}))}\n## Storage accounting at workload end (before shutdown drain)\n\n${storageTables(result.diskWriteAccountingAtEnd ?? writeAccounting({}, {}))}`
    await writeFile(resolve(output, 'report.md'), report)
    await writeFile(resolve(output, 'run-context.json'), `${JSON.stringify(runContext, null, 2)}\n`)
    console.log(JSON.stringify({ status: result.status, output, totalRecords, workerCount,
        createAndIndexMs: result.createAndIndexMs, failure: result.failure }))
}
