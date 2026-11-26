import { waitForIndex } from '../shared/wait-for-index.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { availableParallelism, tmpdir, totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRuntime } from '../../../src/runtime.js'
import { benchmarkUuid, lifecycleRoot } from '../../fixtures/lifecycle.mjs'
import { createProgressReporter } from '../shared/workloads.mjs'
import { createResidencyRecord } from './fixtures/residency.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const size = Number(process.argv[2] ?? 10_000)
const fraction = Number(process.argv[3] ?? 0.5)
if (!Number.isSafeInteger(size) || size < 2) throw Error('Size must be an integer of at least 2')
if (!(fraction > 0 && fraction <= 1)) throw Error('Eviction fraction must be greater than 0 and at most 1')

const startedAt = new Date()
const runId = startedAt.toISOString().replaceAll(':', '-')
const outputDir = resolve(process.env.BENCH_OUTPUT_DIR ?? join(here, 'results'))
const outputFile = join(outputDir, `weighted-eviction-${runId}.json`)
const directory = join(tmpdir(), `cocreatedb-weighted-${process.pid}-${Date.now()}`)
const root = lifecycleRoot(size)
const db = await createRuntime({}, { directory, memoryPolicy: false })
const send = (method, extra) => db.send({ ...root, method: `object.${method}`, ...extra })
const progress = createProgressReporter('cocreatedb-weighted-eviction', size)
const elapsed = start => performance.now() - start
const memory = () => process.memoryUsage()

async function directoryBytes(path) {
    let bytes = 0
    for (const entry of await readdir(path, { withFileTypes: true })) {
        const item = join(path, entry.name)
        bytes += entry.isDirectory() ? await directoryBytes(item) : (await stat(item)).size
    }
    return bytes
}

const result = {
    benchmark: 'cocreatedb-weighted-eviction-diagnostic',
    benchmarkVersion: 1,
    fixture: 'residency diagnostic fixture v1',
    fixtureVersion: 1,
    runId,
    startedAt: startedAt.toISOString(),
    sourceRevision: (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: resolve(here, '../../..'), encoding: 'utf8' }).trim() } catch { return null } })(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    cpuCount: availableParallelism(),
    totalMemoryBytes: totalmem(),
    datasetSize: size,
    evictionFraction: fraction,
    status: 'running'
}

try {
    const cpuStart = process.cpuUsage()
    const createStart = performance.now()
    const batchSize = 250
    for (let offset = 0; offset < size; offset += batchSize) {
        const end = Math.min(size, offset + batchSize)
        const records = Array.from({ length: end - offset }, (_, i) => createResidencyRecord(offset + i, size, root.organization_id))
        const response = await send('create', { object: records })
        assert.equal(response.success, true, JSON.stringify(response.error))
        assert.equal(response.object.length, records.length)
        progress(end)
    }
    await waitForIndex(db)
    result.createAndIndexMs = elapsed(createStart)
    result.memoryAfterCreate = memory()

    const touchCount = Math.min(size - 1, 100)
    const touchStart = performance.now()
    for (let rank = 0; rank < touchCount; rank++) {
        const response = await send('read', { object: { uuid: benchmarkUuid(rank) } })
        assert.equal(response.success, true, JSON.stringify(response.error))
        assert.equal(response.object[0]?.uuid, benchmarkUuid(rank))
    }
    result.hotReadMs = elapsed(touchStart)

    const evictionStart = performance.now()
    result.indexEviction = await db.local.evictAsync(Infinity, fraction)
    result.leafEviction = await db.leafTier.evict(fraction)
    result.evictionMs = elapsed(evictionStart)
    result.afterEviction = {
        residentLeaves: db.leafTier.size,
        warmLeaves: db.leafTier.warm.size,
        indexReads: db.local.reads,
        indexWrites: db.local.writes,
        leafReads: db.leafTier.reads,
        leafWrites: db.leafTier.writes,
        memory: memory()
    }

    const hotUuid = benchmarkUuid(0)
    const warmUuid = db.leafTier.warm.keys().next().value
    assert.ok(warmUuid, 'weighted eviction should move at least one leaf to the warm tier')
    const warmRank = Number.parseInt(warmUuid, 16)
    assert.equal(db.leafTier.warm.has(hotUuid), false, 'frequently read leaf should remain resident without a disk copy')
    const hydrateStart = performance.now()
    const hydrated = await send('read', { object: { uuid: warmUuid } })
    result.hydrationMs = elapsed(hydrateStart)
    assert.equal(hydrated.success, true, JSON.stringify(hydrated.error))
    assert.equal(hydrated.object[0]?.uuid, warmUuid)
    assert.equal(hydrated.object[0]?.rank, warmRank)
    assert.equal(db.leafTier.warm.has(warmUuid), true, 'hydration should retain the warm disk copy')
    result.afterHydration = {
        residentLeaves: db.leafTier.size,
        warmLeaves: db.leafTier.warm.size,
        indexReads: db.local.reads,
        indexWrites: db.local.writes,
        leafReads: db.leafTier.reads,
        leafWrites: db.leafTier.writes,
        diskBytes: await directoryBytes(directory),
        memory: memory()
    }
    result.cpuUsageUs = process.cpuUsage(cpuStart)
    result.status = 'passed'
} catch (error) {
    result.status = 'failed'
    result.failure = { name: error.name, message: error.message, stack: error.stack }
} finally {
    result.completedAt = new Date().toISOString()
    await mkdir(outputDir, { recursive: true })
    await writeFile(outputFile, `${JSON.stringify(result, null, 2)}\n`)
    await rm(directory, { recursive: true, force: true })
    process.stdout.write(`result=${outputFile}\n`)
}

if (result.status !== 'passed') process.exitCode = 1
