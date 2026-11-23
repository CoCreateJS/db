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
const db = await createDB({}, { directory, deferIndex: true, memoryPolicy: false, size: 64 })
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
const chunkSize = 250
const updateCount = Math.min(size, 500)
const deleteCount = Math.min(size, 100)
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
    chunkSize,
    deferIndex: true,
    updateCount,
    deleteCount,
    status: 'running'
}

async function createPhase() {
    const times = []
    const hash = createHash('sha256')
    const progress = createProgressReporter('cocreatedb-deferred-create', size)
    for (let offset = 0; offset < size; offset += chunkSize) {
        const end = Math.min(size, offset + chunkSize)
        const records = Array.from({ length: end - offset }, (_, i) => createResidencyRecord(offset + i, size, root.organization_id))
        for (const record of records) hash.update(JSON.stringify(record))
        const start = performance.now()
        const response = await send('create', { object: records })
        times.push(performance.now() - start)
        assert.equal(response.success, true, JSON.stringify(response.error))
        assert.equal(response.object.length, records.length)
        progress(end)
    }
    result.fixtureHash = hash.digest('hex')
    result.createAcknowledgementMs = times.reduce((sum, time) => sum + time, 0)
    result.createChunkLatencyMs = { p50: percentile(times, 0.5), p95: percentile(times, 0.95), p99: percentile(times, 0.99) }
    result.pendingAfterCreate = db.pendingIndexCount
    result.createAcknowledgementMemory = process.memoryUsage()
    const drainStart = performance.now()
    await db.flushIndex()
    result.createIndexDrainMs = performance.now() - drainStart
    result.pendingAfterCreateDrain = db.pendingIndexCount
    assert.equal(result.pendingAfterCreateDrain, 0)
}

async function updatePhase() {
    const progress = createProgressReporter('cocreatedb-deferred-update', updateCount)
    const times = []
    for (let rank = 0; rank < updateCount; rank++) {
        const start = performance.now()
        const response = await send('update', { object: { uuid: rank.toString(16).padStart(32, '0'), rank: size + rank } })
        times.push(performance.now() - start)
        assert.equal(response.success, true, JSON.stringify(response.error))
        progress(rank + 1)
    }
    result.updateAcknowledgementMs = times.reduce((sum, time) => sum + time, 0)
    result.updateLatencyMs = { p50: percentile(times, 0.5), p95: percentile(times, 0.95), p99: percentile(times, 0.99) }
    result.pendingAfterUpdate = db.pendingIndexCount
    const drainStart = performance.now()
    await db.flushIndex()
    result.updateIndexDrainMs = performance.now() - drainStart
    result.pendingAfterUpdateDrain = db.pendingIndexCount
    assert.equal(result.pendingAfterUpdateDrain, 0)
    const selected = await send('read', { filter: { query: { rank: { $gte: size, $lt: size + updateCount } }, limit: 0 } })
    assert.equal(selected.success, true, JSON.stringify(selected.error))
    assert.equal(selected.object.length, updateCount)
}

async function deletePhase() {
    const times = []
    const progress = createProgressReporter('cocreatedb-deferred-delete', deleteCount)
    for (let rank = 0; rank < deleteCount; rank++) {
        const start = performance.now()
        const response = await send('delete', { object: { uuid: rank.toString(16).padStart(32, '0') } })
        times.push(performance.now() - start)
        assert.equal(response.success, true, JSON.stringify(response.error))
        progress(rank + 1)
    }
    result.deleteAcknowledgementMs = times.reduce((sum, time) => sum + time, 0)
    result.deleteLatencyMs = { p50: percentile(times, 0.5), p95: percentile(times, 0.95), p99: percentile(times, 0.99) }
    result.pendingAfterDelete = db.pendingIndexCount
    const drainStart = performance.now()
    await db.flushIndex()
    result.deleteIndexDrainMs = performance.now() - drainStart
    result.pendingAfterDeleteDrain = db.pendingIndexCount
    assert.equal(result.pendingAfterDeleteDrain, 0)
    for (let rank = 0; rank < deleteCount; rank++) {
        const response = await send('read', { object: { uuid: rank.toString(16).padStart(32, '0') } })
        assert.equal(response.success, true, JSON.stringify(response.error))
        assert.equal(response.object.length, 0)
    }
}

try {
    await createPhase()
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
    result.completedAt = new Date().toISOString()
    await mkdir(outputDir, { recursive: true })
    await writeFile(outputFile, `${JSON.stringify(result, null, 2)}\n`)
    await rm(directory, { recursive: true, force: true })
    process.stdout.write(`result=${outputFile}\n`)
}

if (result.status !== 'passed') process.exitCode = 1
