import { randomBytes } from 'node:crypto'
import { availableParallelism, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createDB } from '../../../src/index.js'
import { removeMemoryPath } from '../../../src/memory.js'

const durationMs = Number(process.env.BENCH_DURATION_MS ?? 60_000)
const concurrencyLevels = (process.env.BENCH_CONCURRENCY ?? '1,4,16').split(',').map(Number)
const size = Number(process.env.BENCH_SIZE ?? 1000)
const percentile = (values, fraction) => {
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0
}
const assertSuccess = (response, label) => {
    if (!response || response.success === false) throw Error(`${label} failed: ${response?.error?.join('; ') ?? 'no response'}`)
    return response
}
const sampleMemory = (db, stats) => {
    const memory = process.memoryUsage()
    stats.maxRss = Math.max(stats.maxRss, memory.rss)
    stats.maxHeapUsed = Math.max(stats.maxHeapUsed, memory.heapUsed)
    stats.maxPendingIndexes = Math.max(stats.maxPendingIndexes, db.persistenceStats().pendingIndexes ?? 0)
}
const summarizePhase = (name, concurrency, duration, latencies, cpu, before, after, stats, timingBefore) => {
    const timingAfter = db.persistenceStats()
    const timing = key => (timingAfter[key] ?? 0) - (timingBefore[key] ?? 0)
    return ({
    name,
    concurrency,
    targetDurationMs: duration,
    actualDurationMs: after.wallMs,
    operations: latencies.length,
    operationsPerSecond: latencies.length / (after.wallMs / 1000),
    latencyMs: { p50: percentile(latencies, 0.50), p95: percentile(latencies, 0.95), p99: percentile(latencies, 0.99),
        max: latencies.reduce((maximum, value) => Math.max(maximum, value), 0) },
    cpuPercentOfOneCore: (cpu.user + cpu.system) / 1000 / after.wallMs * 100,
    cpuPercentOfMachine: (cpu.user + cpu.system) / 1000 / after.wallMs / availableParallelism() * 100,
    memory: { startRss: before.rss, endRss: process.memoryUsage().rss, maxRss: stats.maxRss,
        startHeapUsed: before.heapUsed, endHeapUsed: process.memoryUsage().heapUsed, maxHeapUsed: stats.maxHeapUsed },
    pendingIndexWork: { peak: stats.maxPendingIndexes, end: db.persistenceStats().pendingIndexes ?? 0 },
    indexError: db.persistenceStats().indexError,
    indexTimingMs: { schedulingWait: timing('indexSchedulingWaitMs'), actualProcessing: timing('indexProcessingMs'),
        explicitFlushWait: timing('indexFlushWaitMs') }
    })
}

const results = {
    benchmark: 'cocreatedb-sustained-read-write',
    startedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    cpuCount: availableParallelism(),
    size,
    durationMs,
    concurrencyLevels,
    configuration: 'filesystem persistence enabled; writeBehind true; one process; no peer or external persistence latency',
    phases: [],
    setup: {}
}

const directory = await mkdtemp(join(tmpdir(), 'coc-db-sustained-'))
const organization_id = randomBytes(12).toString('hex')
const scope = { organization_id, storage: 'bench', database: 'app', array: 'records' }
let db = createDB({ directory, writeBehind: true, nodeId: 'benchmark' })
const send = (method, extra = {}) => db.send({ ...scope, method: `object.${method}`, ...extra })
try {
    for (const request of [
        { method: 'storage.create', storage: { name: scope.storage } },
        { method: 'database.create', database: { name: scope.database } },
        { method: 'array.create', array: { name: scope.array } }
    ]) assertSuccess(await db.send({ ...scope, ...request }), request.method)

    const documents = Array.from({ length: size }, (_, rank) => ({
        rank, group: `group-${rank % 10}`, profile: { team: `team-${rank % 20}` }, revision: 0
    }))
    const insertStarted = performance.now()
    assertSuccess(await send('create', { object: documents }), 'initial object.create')
    const initialAckMs = performance.now() - insertStarted
    const initialIndexStarted = performance.now()
    await db.flushIndexes()
    const initialIndexBuildMs = performance.now() - initialIndexStarted
    const initialPersistenceStarted = performance.now()
    await db.flushPersistence()
    const initialPersistenceFlushMs = performance.now() - initialPersistenceStarted
    results.setup.initialObjectInsertAckMs = initialAckMs
    results.setup.initialIndexBuildMs = initialIndexBuildMs
    results.setup.initialPersistenceFlushMs = initialPersistenceFlushMs
    results.setup.pendingAfterInitialFlush = db.persistenceStats().pendingIndexes

    // Reopen after evicting in-process JSON cache to measure first disk access.
    await db.close()
    removeMemoryPath(directory)
    db = createDB({ directory, writeBehind: true, nodeId: 'benchmark' })
    const reopenedSend = (method, extra = {}) => db.send({ ...scope, method: `object.${method}`, ...extra })
    const coldStarted = performance.now()
    const cold = assertSuccess(await reopenedSend('read', { object: { uuid: documents[Math.floor(size / 2)].uuid } }), 'cold UUID read')
    results.setup.coldFirstReadMs = performance.now() - coldStarted
    if (cold.object?.length !== 1) throw Error('cold UUID read did not return exactly one record')
    const warmStarted = performance.now()
    assertSuccess(await reopenedSend('read', { object: { uuid: documents[Math.floor(size / 2)].uuid } }), 'warm UUID read')
    results.setup.warmRepeatedReadMs = performance.now() - warmStarted
    await db.flush()

    for (const concurrency of concurrencyLevels) {
        for (const name of ['read', 'write']) {
            await db.flush()
            const latencies = []
            const before = process.memoryUsage()
            const timingBefore = db.persistenceStats()
            const stats = { maxRss: before.rss, maxHeapUsed: before.heapUsed, maxPendingIndexes: db.persistenceStats().pendingIndexes ?? 0 }
            const cpuBefore = process.cpuUsage()
            const started = performance.now()
            const deadline = started + durationMs
            let completed = 0
            const workers = Array.from({ length: concurrency }, (_, worker) => (async () => {
                let operation = worker
                while (performance.now() < deadline) {
                    const at = performance.now()
                    if (name === 'read') {
                        const item = documents[(operation * concurrency + worker) % documents.length]
                        if (operation % 2)
                            assertSuccess(await reopenedSend('read', { object: { uuid: item.uuid } }), 'sustained UUID read')
                        else
                            assertSuccess(await reopenedSend('read', { filter: { query: { rank: { $gte: 0, $lt: size } }, limit: 1 } }), 'sustained range read')
                    } else {
                        const item = documents[(operation * concurrency + worker) % documents.length]
                        assertSuccess(await reopenedSend('update', {
                            object: { uuid: item.uuid, $update: { $inc: { revision: 1 } } }
                        }), 'sustained UUID update')
                    }
                    latencies.push(performance.now() - at)
                    completed++
                    operation++
                }
            })())
            const monitor = setInterval(() => sampleMemory(db, stats), 250)
            await Promise.all(workers)
            clearInterval(monitor)
            const wallMs = performance.now() - started
            const cpu = process.cpuUsage(cpuBefore)
            sampleMemory(db, stats)
            const beforeSummary = { rss: before.rss, heapUsed: before.heapUsed }
            results.phases.push(summarizePhase(name, concurrency, durationMs, latencies, cpu, beforeSummary, { wallMs }, stats, timingBefore))
            results.phases.at(-1).operations = completed
            if (name === 'write') {
                const pendingBeforeFlush = db.persistenceStats().pendingIndexes ?? 0
                const drainTimingBefore = db.persistenceStats()
                const indexFlushStarted = performance.now()
                await db.flushIndexes()
                const indexFlushMs = performance.now() - indexFlushStarted
                const drainTimingAfter = db.persistenceStats()
                const persistenceFlushStarted = performance.now()
                await db.flushPersistence()
                const persistenceFlushMs = performance.now() - persistenceFlushStarted
                Object.assign(results.phases.at(-1), { pendingBeforeDrain: pendingBeforeFlush, indexDrainMs: indexFlushMs,
                    indexDrainTimingMs: {
                        actualProcessing: (drainTimingAfter.indexProcessingMs ?? 0) - (drainTimingBefore.indexProcessingMs ?? 0),
                        schedulingWait: (drainTimingAfter.indexSchedulingWaitMs ?? 0) - (drainTimingBefore.indexSchedulingWaitMs ?? 0),
                        explicitFlushWait: (drainTimingAfter.indexFlushWaitMs ?? 0) - (drainTimingBefore.indexFlushWaitMs ?? 0)
                    }, persistenceDrainMs: persistenceFlushMs, pendingAfterDrain: db.persistenceStats().pendingIndexes ?? 0 })
            }
            console.log(`${name} concurrency=${concurrency} ops=${completed} ops/s=${(completed / wallMs * 1000).toFixed(1)} p95=${percentile(latencies, 0.95).toFixed(2)}ms`)
        }
    }
} finally {
    await db.close()
    removeMemoryPath(directory)
    await rm(directory, { recursive: true, force: true })
}

results.completedAt = new Date().toISOString()
const outputDirectory = resolve('test/benchmarks/db-lifecycle-20261118/results')
await mkdir(outputDirectory, { recursive: true })
const output = join(outputDirectory, `sustained-${results.startedAt.replaceAll(':', '-')}.json`)
await writeFile(output, `${JSON.stringify(results, null, 2)}\n`)
console.log(`results=${output}`)
