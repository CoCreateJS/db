import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { availableParallelism, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import createDB from '../../../src/index.js'
import { lifecycleRoot } from '../../fixtures/lifecycle.mjs'
import { createProgressReporter } from '../shared/workloads.mjs'
import { createResidencyRecord } from './fixtures/residency.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const size = Number(process.argv[2] ?? 10_000)
if (!Number.isSafeInteger(size) || size < 100) throw Error('Size must be an integer of at least 100')

const startedAt = new Date()
const runId = startedAt.toISOString().replaceAll(':', '-')
const outputDir = resolve(process.env.BENCH_OUTPUT_DIR ?? join(here, 'results'))
const outputFile = join(outputDir, `deferred-indexing-${runId}.json`)
const directory = join(tmpdir(), `cocreatedb-deferred-${process.pid}-${Date.now()}`)
const root = lifecycleRoot(size)
const db = await createDB({}, { directory, mode: 'adaptive', size: 64 })
const send = (method, extra) => db.send({ ...root, method: `object.${method}`, ...extra })
const percentile = (values, ratio) => {
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)] ?? 0
}
const sourceRevision = () => {
    try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: resolve(here, '../../..'), encoding: 'utf8' }).trim() }
    catch { return null }
}
const cpuStart = process.cpuUsage()
const wallStart = performance.now()
const chunkSize = 1
const updateCount = size
const deleteCount = size
const directReadCount = size
const indexedReadCount = Math.min(size, 10_000)
const createdUuids = []
const result = {
    benchmark: 'cocreatedb-deferred-indexing-diagnostic',
    benchmarkVersion: 1,
    fixture: 'residency diagnostic fixture v1',
    fixtureVersion: 1,
    runId,
    startedAt: startedAt.toISOString(),
    sourceRevision: sourceRevision(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    cpuCount: availableParallelism(),
    datasetSize: size,
    createUuidMode: 'generated-by-database',
    chunkSize,
    mode: 'adaptive',
    acknowledgement: 'memory',
    memoryPercent: db.memory.percent,
    updateCount,
    deleteCount,
    directReadCount,
    indexedReadCount,
    status: 'running'
}

const diskMetrics = new Map()
const disk = db.disk
db.disk = async envelope => {
    const request = envelope?.disk ?? {}
    const key = `${envelope?.method ?? 'unknown'}:${request.kind ?? 'unknown'}`
    const metric = diskMetrics.get(key) ?? { count: 0, totalMs: 0, bytes: 0, latencies: [] }
    const started = performance.now()
    try { return await disk(envelope) }
    finally {
        const elapsed = performance.now() - started
        metric.count++
        metric.totalMs += elapsed
        metric.latencies.push(elapsed)
        if (typeof request.data === 'string') metric.bytes += Buffer.byteLength(request.data)
        diskMetrics.set(key, metric)
    }
}
const diskSnapshot = () => Object.fromEntries([...diskMetrics].map(([key, metric]) => [key, { ...metric }]))
const diskDifference = before => Object.fromEntries([...diskMetrics].flatMap(([key, metric]) => {
    const previous = before[key] ?? { count: 0, totalMs: 0, bytes: 0 }
    const latencies = metric.latencies.slice(previous.count).sort((a, b) => a - b)
    const percentile = ratio => latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * ratio) - 1)] ?? 0
    return [[key, {
        count: metric.count - previous.count,
        totalMs: metric.totalMs - previous.totalMs,
        bytes: metric.bytes - previous.bytes,
        latencyMs: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) }
    }]]
}))

async function createPhase() {
    const times = []
    const hash = createHash('sha256')
    const progress = createProgressReporter('cocreatedb-deferred-create', size)
    const diskBefore = diskSnapshot()
    for (let offset = 0; offset < size; offset += chunkSize) {
        const end = Math.min(size, offset + chunkSize)
        const records = Array.from({ length: end - offset }, (_, i) => {
            const record = createResidencyRecord(offset + i, size, root.organization_id)
            delete record.uuid
            return record
        })
        for (const record of records) hash.update(JSON.stringify(record))
        const start = performance.now()
        const response = await send('create', { object: records })
        times.push(performance.now() - start)
        assert.equal(response.success, true, JSON.stringify(response.error))
        assert.equal(response.object.length, records.length)
        createdUuids.push(...response.object.map(record => record.uuid))
        progress(end)
    }
    result.fixtureHash = hash.digest('hex')
    result.createAcknowledgementMs = times.reduce((sum, time) => sum + time, 0)
    result.createOpsPerSecond = size / result.createAcknowledgementMs * 1000
    result.createRequestLatencyMs = { p50: percentile(times, 0.5), p95: percentile(times, 0.95), p99: percentile(times, 0.99) }
    result.pendingAfterCreate = db.pendingIndexCount
    result.createAcknowledgementMemory = process.memoryUsage()
    const drainStart = performance.now()
    await db.flushIndex()
    result.createIndexDrainMs = performance.now() - drainStart
    result.pendingAfterCreateDrain = db.pendingIndexCount
    assert.equal(result.pendingAfterCreateDrain, 0)
    const indexDiskStart = performance.now()
    await db.flushDisk()
    result.createLocalDiskFlushAfterIndexMs = performance.now() - indexDiskStart
    result.createDiskOperations = diskDifference(diskBefore)
}

async function updatePhase() {
    const progress = createProgressReporter('cocreatedb-deferred-update', updateCount)
    const times = []
    const diskBefore = diskSnapshot()
    for (let rank = 0; rank < updateCount; rank++) {
        const start = performance.now()
        const response = await send('update', { object: { uuid: createdUuids[rank], rank: size + rank } })
        times.push(performance.now() - start)
        assert.equal(response.success, true, JSON.stringify(response.error))
        progress(rank + 1)
    }
    result.updateAcknowledgementMs = times.reduce((sum, time) => sum + time, 0)
    result.updateOpsPerSecond = updateCount / result.updateAcknowledgementMs * 1000
    result.updateLatencyMs = { p50: percentile(times, 0.5), p95: percentile(times, 0.95), p99: percentile(times, 0.99) }
    result.updateAcknowledgementMemory = process.memoryUsage()
    result.pendingAfterUpdate = db.pendingIndexCount
    const drainStart = performance.now()
    await db.flushIndex()
    result.updateIndexDrainMs = performance.now() - drainStart
    result.pendingAfterUpdateDrain = db.pendingIndexCount
    assert.equal(result.pendingAfterUpdateDrain, 0)
    const indexDiskStart = performance.now()
    await db.flushDisk()
    result.updateLocalDiskFlushAfterIndexMs = performance.now() - indexDiskStart
    result.updateDiskOperations = diskDifference(diskBefore)
    const selected = await send('read', { filter: { query: { rank: { $gte: size, $lt: size + updateCount } }, limit: 0 } })
    assert.equal(selected.success, true, JSON.stringify(selected.error))
    assert.equal(selected.object.length, updateCount)
}

async function readPhase() {
    const directTimes = []
    const directDiskBefore = diskSnapshot()
    const directStart = performance.now()
    for (let rank = 0; rank < directReadCount; rank++) {
        const uuid = createdUuids[rank]
        const started = performance.now()
        const response = await send('read', { object: { uuid } })
        directTimes.push(performance.now() - started)
        assert.equal(response.success, true, JSON.stringify(response.error))
        assert.equal(response.object.length, 1)
        assert.equal(response.object[0].uuid, uuid)
    }
    result.directUuidReadMs = performance.now() - directStart
    result.directUuidReadOpsPerSecond = directReadCount / result.directUuidReadMs * 1000
    result.directUuidReadLatencyMs = { p50: percentile(directTimes, 0.5), p95: percentile(directTimes, 0.95), p99: percentile(directTimes, 0.99) }
    result.directUuidReadDiskOperations = diskDifference(directDiskBefore)

    const indexedTimes = []
    const indexedDiskBefore = diskSnapshot()
    const indexedStart = performance.now()
    for (let sample = 0; sample < indexedReadCount; sample++) {
        const rank = Math.floor(sample * size / indexedReadCount)
        const uuid = createdUuids[rank]
        const started = performance.now()
        const response = await send('read', { filter: { query: { rank }, limit: 1 } })
        indexedTimes.push(performance.now() - started)
        assert.equal(response.success, true, JSON.stringify(response.error))
        assert.equal(response.object.length, 1)
        assert.equal(response.object[0].uuid, uuid)
    }
    result.indexedEqualityReadMs = performance.now() - indexedStart
    result.indexedEqualityReadOpsPerSecond = indexedReadCount / result.indexedEqualityReadMs * 1000
    result.indexedEqualityReadLatencyMs = { p50: percentile(indexedTimes, 0.5), p95: percentile(indexedTimes, 0.95), p99: percentile(indexedTimes, 0.99) }
    result.indexedEqualityReadDiskOperations = diskDifference(indexedDiskBefore)
}

async function deletePhase() {
    const times = []
    const progress = createProgressReporter('cocreatedb-deferred-delete', deleteCount)
    const diskBefore = diskSnapshot()
    for (let rank = 0; rank < deleteCount; rank++) {
        const start = performance.now()
        const response = await send('delete', { object: { uuid: createdUuids[rank] } })
        times.push(performance.now() - start)
        assert.equal(response.success, true, JSON.stringify(response.error))
        progress(rank + 1)
    }
    result.deleteAcknowledgementMs = times.reduce((sum, time) => sum + time, 0)
    result.deleteOpsPerSecond = deleteCount / result.deleteAcknowledgementMs * 1000
    result.deleteLatencyMs = { p50: percentile(times, 0.5), p95: percentile(times, 0.95), p99: percentile(times, 0.99) }
    result.deleteAcknowledgementMemory = process.memoryUsage()
    result.pendingAfterDelete = db.pendingIndexCount
    const drainStart = performance.now()
    await db.flushIndex()
    result.deleteIndexDrainMs = performance.now() - drainStart
    result.pendingAfterDeleteDrain = db.pendingIndexCount
    assert.equal(result.pendingAfterDeleteDrain, 0)
    const indexDiskStart = performance.now()
    await db.flushDisk()
    result.deleteLocalDiskFlushAfterIndexMs = performance.now() - indexDiskStart
    result.deleteDiskOperations = diskDifference(diskBefore)
    for (let rank = 0; rank < deleteCount; rank++) {
        const response = await send('read', { object: { uuid: createdUuids[rank] } })
        assert.equal(response.success, true, JSON.stringify(response.error))
        assert.equal(response.object.length, 0)
    }
}

try {
    await createPhase()
    await readPhase()
    await updatePhase()
    await deletePhase()
    result.status = 'passed'
} catch (error) {
    result.status = 'failed'
    result.failure = { name: error.name, message: error.message, stack: error.stack }
} finally {
    result.totalElapsedMs = performance.now() - wallStart
    result.cpuUsageUs = process.cpuUsage(cpuStart)
    result.memory = process.memoryUsage()
    result.peakRssBytes = process.resourceUsage().maxRSS * 1024
    result.completedAt = new Date().toISOString()
    await mkdir(outputDir, { recursive: true })
    await writeFile(outputFile, `${JSON.stringify(result, null, 2)}\n`)
    try { await db.close() } catch (error) {
        result.status = 'failed'
        result.cleanupFailure = error.message
    }
    await rm(directory, { recursive: true, force: true })
    process.stdout.write(`result=${outputFile}\n`)
}

if (result.status !== 'passed') process.exitCode = 1
