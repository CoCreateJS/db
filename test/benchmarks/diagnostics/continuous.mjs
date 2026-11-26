import { waitForIndex } from '../shared/wait-for-index.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { availableParallelism, tmpdir, totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PerformanceObserver } from 'node:perf_hooks'
import createDB from '../../../src/index.js'
import { benchmarkUuid, lifecycleRoot } from '../../fixtures/lifecycle.mjs'
import { createProgressReporter } from '../shared/workloads.mjs'
import { createResidencyRecord } from './fixtures/residency.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const target = Number(process.argv[2] ?? 10_000)
if (!Number.isSafeInteger(target) || target < 1) throw Error('Target must be a positive integer')
const systemMemory = Number(process.env.BENCH_SYSTEM_MIB ?? totalmem() / 1024 ** 2) * 1024 ** 2
if (!Number.isFinite(systemMemory) || systemMemory <= 0) throw Error('BENCH_SYSTEM_MIB must be positive')

const startedAt = new Date()
const runId = startedAt.toISOString().replaceAll(':', '-')
const outputDir = resolve(process.env.BENCH_OUTPUT_DIR ?? join(here, 'results'))
const outputFile = join(outputDir, `continuous-${runId}.json`)
const directory = join(tmpdir(), `cocreatedb-continuous-${process.pid}-${Date.now()}`)
const root = lifecycleRoot(target)
const db = await createDB({}, {
    directory,
    size: 64,
    config: { memory: 25 },
    memoryPolicy: { systemMemory, interval: 1000 }
})
const send = (method, extra) => db.send({ ...root, method: `object.${method}`, ...extra })
const createdProgress = createProgressReporter('cocreatedb-continuous', target)
const live = []
const expectedRevision = new Map()
const metrics = new Map()
const memorySamples = []
const gcEvents = []
let workloadSeed = 123456789
let sampleSeed = 987654321
let created = 0
let operations = 0
let lastProgress = 0
const cpuStart = process.cpuUsage()
const start = performance.now()

const random = () => {
    workloadSeed = (Math.imul(workloadSeed, 1664525) + 1013904223) >>> 0
    return workloadSeed / 2 ** 32
}
const sampleRandom = () => {
    sampleSeed = (Math.imul(sampleSeed, 1664525) + 1013904223) >>> 0
    return sampleSeed / 2 ** 32
}
const swapCounters = () => {
    try {
        const values = Object.fromEntries(requireFs.readFileSync('/proc/vmstat', 'utf8')
            .split('\n').map(line => line.split(' ')).filter(([key]) => key === 'pswpin' || key === 'pswpout')
            .map(([key, value]) => [key, Number(value)]))
        return values
    } catch { return null }
}
const requireFs = await import('node:fs')
const sample = () => {
    const { rss, heapUsed, external } = process.memoryUsage()
    memorySamples.push({
        elapsedMs: performance.now() - start,
        rssBytes: rss,
        heapUsedBytes: heapUsed,
        externalBytes: external,
        pendingIndexCount: db.pendingIndexCount,
        residentLeaves: db.leafTier.size,
        warmLeaves: db.leafTier.warm.size,
        created,
        operations
    })
}
const timer = setInterval(sample, 1000)
const observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {
        const { detail, duration } = entry.toJSON()
        gcEvents.push({ ...detail, durationMs: duration })
    }
})
try { observer.observe({ entryTypes: ['gc'] }) } catch {}
const swapStart = swapCounters()

function addMetric(name, latencyMs) {
    const metric = metrics.get(name) ?? { count: 0, totalMs: 0, samples: [] }
    metric.count++
    metric.totalMs += latencyMs
    if (metric.samples.length < 20_000) metric.samples.push(latencyMs)
    else {
        const index = Math.floor(sampleRandom() * metric.count)
        if (index < metric.samples.length) metric.samples[index] = latencyMs
    }
    metrics.set(name, metric)
}

async function diskBytes(path) {
    let bytes = 0
    for (const entry of await readdir(path, { withFileTypes: true })) {
        const item = join(path, entry.name)
        bytes += entry.isDirectory() ? await diskBytes(item) : (await stat(item)).size
    }
    return bytes
}

function summarizeMetric(metric) {
    metric.samples.sort((a, b) => a - b)
    const percentile = ratio => metric.samples[Math.min(metric.samples.length - 1, Math.ceil(metric.samples.length * ratio) - 1)] ?? 0
    return {
        count: metric.count,
        meanMs: metric.totalMs / metric.count,
        p50Ms: percentile(0.5),
        p95Ms: percentile(0.95),
        p99Ms: percentile(0.99)
    }
}

const result = {
    benchmark: 'cocreatedb-continuous-residency-diagnostic',
    benchmarkVersion: 1,
    fixture: 'residency diagnostic fixture v1',
    fixtureVersion: 1,
    runId,
    startedAt: startedAt.toISOString(),
    sourceRevision: (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: resolve(here, '../../..'), encoding: 'utf8' }).trim() } catch { return null } })(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    cpuCount: availableParallelism(),
    systemMemoryBudgetBytes: systemMemory,
    memoryBudgetBytes: db.memoryPolicy.budget,
    memoryPercent: 25,
    targetCreations: target
}

try {
    while (created < target) {
        const roll = random()
        let method
        let request
        let expectedRange
        let selectedUuid

        if (!live.length || roll < 0.55) {
            method = 'create'
            const record = createResidencyRecord(created, target, root.organization_id)
            selectedUuid = record.uuid
            request = { object: record }
        } else {
            const position = Math.floor(random() * live.length)
            selectedUuid = live[position]
            if (roll < 0.75) {
                method = 'read'
                request = { object: { uuid: selectedUuid } }
            } else if (roll < 0.82) {
                method = 'range'
                const rank = Number.parseInt(selectedUuid, 16)
                request = { filter: { query: { rank: { $gte: rank, $lt: rank + 10 } }, limit: 10 } }
                expectedRange = live.filter(uuid => {
                    const value = Number.parseInt(uuid, 16)
                    return value >= rank && value < rank + 10
                })
            } else if (roll < 0.95) {
                method = 'update'
                request = { object: { uuid: selectedUuid, revision: expectedRevision.get(selectedUuid) + 1 } }
            } else {
                method = 'delete'
                request = { object: { uuid: selectedUuid } }
            }
        }

        const before = performance.now()
        const response = await send(method === 'range' ? 'read' : method, request)
        const latencyMs = performance.now() - before
        assert.equal(response.success, true, JSON.stringify(response.error))
        if (expectedRange) {
            assert.deepEqual(new Set(response.object.map(item => item.uuid)), new Set(expectedRange))
        } else {
            assert.equal(response.object.length, 1)
            assert.equal(response.object[0].uuid, selectedUuid)
            if (method === 'create') {
                created++
                live.push(selectedUuid)
                expectedRevision.set(selectedUuid, 0)
                createdProgress(created)
            } else if (method === 'update') expectedRevision.set(selectedUuid, request.object.revision)
            else if (method === 'delete') {
                live.splice(live.indexOf(selectedUuid), 1)
                expectedRevision.delete(selectedUuid)
            } else assert.equal(response.object[0].revision, expectedRevision.get(selectedUuid))
        }
        addMetric(method, latencyMs)
        operations++
        if (operations % 64 === 0) await new Promise(setImmediate)
        if (performance.now() - lastProgress > 10_000) {
            process.stdout.write(`BENCH_PROGRESS provider=cocreatedb-continuous created=${created} target=${target} operations=${operations}\n`)
            lastProgress = performance.now()
        }
    }

    sample()
    const drainStart = performance.now()
    await waitForIndex(db)
    result.indexDrainMs = performance.now() - drainStart
    const policyDrainStart = performance.now()
    await db.memoryPolicy.flush()
    result.memoryPolicyDrainMs = performance.now() - policyDrainStart
    result.elapsedMs = performance.now() - start
    result.created = created
    result.liveLeaves = live.length
    result.operations = operations
    result.operationsPerSecond = operations / (result.elapsedMs / 1000)
    result.cpuUsageUs = process.cpuUsage(cpuStart)
    result.memorySamples = memorySamples
    result.operationsByType = Object.fromEntries([...metrics].map(([name, metric]) => [name, summarizeMetric(metric)]))
    result.diskBytes = await diskBytes(directory)
    result.swap = { start: swapStart, end: swapCounters() }
    result.gc = { available: typeof global.gc === 'function', events: gcEvents }
    result.finalMemory = process.memoryUsage()
    result.indexAndLeafIO = {
        indexReads: db.local.reads,
        indexWrites: db.local.writes,
        leafReads: db.leafTier.reads,
        leafWrites: db.leafTier.writes,
        residentLeaves: db.leafTier.size,
        warmLeaves: db.leafTier.warm.size,
        pendingIndexCount: db.pendingIndexCount,
        policySamples: db.memoryPolicy.samples,
        leafPolicySamples: db.memoryPolicy.leafSamples
    }
    result.status = 'passed'
} catch (error) {
    result.status = 'failed'
    result.failure = { name: error.name, message: error.message, stack: error.stack }
} finally {
    clearInterval(timer)
    observer.disconnect()
    result.completedAt = new Date().toISOString()
    await mkdir(outputDir, { recursive: true })
    await writeFile(outputFile, `${JSON.stringify(result, null, 2)}\n`)
    await rm(directory, { recursive: true, force: true })
    process.stdout.write(`result=${outputFile}\n`)
}

if (result.status !== 'passed') process.exitCode = 1
