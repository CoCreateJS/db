import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { availableParallelism, cpus, freemem, release as osRelease, totalmem, version as osVersion } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDB } from '../../src/index.js'
import { benchmarkUuid, createBenchmarkRecord, lifecycleRoot } from '../fixtures/lifecycle.mjs'
import { launch } from './shared/child-process.mjs'
import { createProgressReporter, expectedUuids, parseStandardSizes, STANDARD_SIZES, standardWorkloads } from './shared/workloads.mjs'

const script = fileURLToPath(import.meta.url)
const root = resolve(dirname(script), '../..')
const percentile = (values, fraction) => {
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0
}
const stats = (values, elapsedMs = undefined) => ({
    samples: values.length,
    minMs: Math.min(...values),
    maxMs: Math.max(...values),
    meanMs: values.reduce((sum, value) => sum + value, 0) / values.length,
    p50Ms: percentile(values, 0.50),
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99),
    ...(elapsedMs === undefined ? {} : { totalMs: elapsedMs, opsPerSecond: values.length / elapsedMs * 1000 })
})
const recordEnvironment = () => {
    let memoryLimitBytes
    for (const file of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
        try {
            const value = readFileSync(file).trim()
            if (value !== 'max' && Number.isFinite(Number(value))) memoryLimitBytes = Number(value)
            break
        } catch {}
    }
    return {
        date: new Date().toISOString(),
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        release: osRelease(),
        os: osVersion(),
        cpuModel: cpus()[0]?.model,
        cpuCount: availableParallelism(),
        totalMemoryBytes: totalmem(),
        freeMemoryBytesAtStart: freemem(),
        memoryLimitBytes,
        databaseVersion: JSON.parse(readFileSync(join(root, 'package.json'))).version,
        sourceRevision: gitRevision(),
        processModel: 'single in-process Node process; benchmark client and database share CPU/RSS',
        mode: 'adaptive',
        acknowledgement: 'memory',
        memoryPercent: Number(process.env.BENCH_MEMORY_PERCENT ?? 25),
        persistence: 'external persistence not configured; local Warm disk writes enabled',
        durability: 'local writes are queued after memory acknowledgement; disk drain excluded from request timings',
        diskUsageBytes: null,
        diskIO: null
    }
}
function readFileSync(path) {
    return requireFs.readFileSync(path, 'utf8')
}
const requireFs = await import('node:fs')
function gitRevision() {
    try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() }
    catch { return null }
}
const { execFileSync } = await import('node:child_process')
const assertResponse = (response, label) => {
    if (!response || response.success === false)
        throw Error(`${label}: ${response?.error?.join('; ') ?? 'request failed'}`)
    return response
}
const uuidFor = benchmarkUuid
const memoryPercent = Number(process.env.BENCH_MEMORY_PERCENT ?? 25)
if (!Number.isFinite(memoryPercent) || memoryPercent <= 0 || memoryPercent > 100)
    throw Error('BENCH_MEMORY_PERCENT must be a number greater than 0 and at most 100')
const verifyIds = (response, expected, label) => {
    assertResponse(response, label)
    assert.deepEqual(response.object.map(value => value.uuid), expected, `${label} result ids`)
}
const measure = async (fn, validate, { warmups, samples }) => {
    const firstStart = performance.now()
    const first = await fn('first', 0)
    const firstOperationMs = performance.now() - firstStart
    validate(first)
    for (let i = 0; i < warmups; i++) validate(await fn('warmup', i))
    const values = []
    const start = performance.now()
    for (let i = 0; i < samples; i++) {
        const before = performance.now()
        const result = await fn('sample', i)
        values.push(performance.now() - before)
        validate(result)
    }
    const elapsedMs = performance.now() - start
    return { firstOperationMs, warmups, measured: stats(values, elapsedMs) }
}
const rootRead = (send, root, extra) => send({ ...root, method: 'object.read', ...extra })

async function sustained(send, root, ids, { durationMs, concurrency, mode }) {
    const choose = sequence => ids[(sequence * 7919) % ids.length]
    const execute = async sequence => {
        const write = mode === 'write' || mode === 'mixed' && sequence % 2 === 1
        const request = write
            ? { ...root, method: 'object.update', object: { uuid: choose(sequence), '$inc.revision': 1 } }
            : { ...root, method: 'object.read', object: { uuid: choose(sequence) } }
        const before = performance.now()
        const response = await send(request)
        const elapsed = performance.now() - before
        assertResponse(response, `sustained ${mode}`)
        if (!write) assert.equal(response.object.length, 1)
        return elapsed
    }
    for (let i = 0; i < 10; i++) await execute(i)
    const cpuStart = process.cpuUsage()
    const start = performance.now()
    const deadline = start + durationMs
    const latencies = []
    const latencySampleLimit = 20_000
    let randomState = 0x6d2b79f5
    let sequence = 10
    let operations = 0
    while (performance.now() < deadline) {
        const count = Math.min(concurrency, Math.max(1, Math.ceil(deadline - performance.now())))
        const batch = await Promise.all(Array.from({ length: count }, () => execute(sequence++)))
        for (const latency of batch) {
            if (latencies.length < latencySampleLimit) latencies.push(latency)
            else {
                randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0
                const index = randomState % operations
                if (index < latencySampleLimit) latencies[index] = latency
            }
        }
        operations += batch.length
    }
    const elapsedMs = performance.now() - start
    const cpu = process.cpuUsage(cpuStart)
    return {
        mode, concurrency, durationTargetMs: durationMs, operations, elapsedMs,
        opsPerSecond: operations / elapsedMs * 1000,
        latency: stats(latencies),
        latencyReservoirLimit: latencySampleLimit,
        cpuUsageUs: cpu,
        cpuUtilizationPercent: (cpu.user + cpu.system) / 1000 / elapsedMs * 100,
        memory: process.memoryUsage()
    }
}

async function runOne(size, runIndex, outputFile, { samples, warmups, sustainMs, concurrency }) {
    const environment = recordEnvironment()
    const root = lifecycleRoot(size)
    const result = {
        status: 'running', benchmark: 'cocreatedb-standard-single-node-adaptive',
        benchmarkVersion: 1, fixture: 'shared lifecycle fixture v3', fixtureVersion: '3.0.0',
        runIndex, datasetSize: size, sampleCount: samples, warmupCount: warmups,
        sustainedDurationMs: sustainMs, concurrencyLevels: concurrency,
        environment, configuration: { roots: 'default', indexSize: 64, chunkSize: 1000, deferIndex: false, mode: 'adaptive', acknowledgement: 'memory', memoryPercent },
        startedAt: new Date().toISOString()
    }
    const cpuStart = process.cpuUsage()
    const wallStart = performance.now()
    try {
        const initStart = performance.now()
        const db = await createDB.init(undefined, { prompt: false, config: { memory: memoryPercent }, size: 64, deferIndex: false })
        result.memoryPolicy = {
            requestedPercent: memoryPercent,
            totalMemoryBytes: db.memoryPolicy?.totalMemory,
            availableMemoryBytes: db.memoryPolicy?.availableMemory,
            requestedBudgetBytes: db.memoryPolicy?.requestedBudget,
            effectiveBudgetBytes: db.memoryPolicy?.budget
        }
        result.initializationMs = performance.now() - initStart
        const send = request => db.send(request)
        const idleMemory = process.memoryUsage()
        const readyStart = performance.now()
        assertResponse(await send({ method: 'object.read', object: { uuid: 'readiness-probe' } }), 'database readiness')
        result.readiness = { readyMs: performance.now() - readyStart, ready: true }
        result.memory = { idle: idleMemory }

        const seed = {
            uuid: `seed-${runIndex}-${size}`, _id: `seed-${runIndex}-${size}`,
            rank: -1, group: 'seed', active: false, createdAt: '2020-01-01T00:00:00.000Z',
            profile: { team: 'seed', score: 0, location: { region: 'seed', verified: false } },
            tags: [], payload: 'seed', bulkDelete: false, revision: 0
        }
        const firstCreateStart = performance.now()
        const firstCreate = assertResponse(await send({ ...root, method: 'object.create', object: seed }), 'first object create')
        result.firstObjectCreateMs = performance.now() - firstCreateStart
        assert.equal(firstCreate.object.length, 1)

        const hash = createHash('sha256')
        hash.update('[')
        let firstRecord = true
        let indexEntriesPerObject
        let createAndIndexMs = 0
        const chunkSize = 1000
        const reportProgress = createProgressReporter('cocreatedb', size)
        for (let offset = 0; offset < size; offset += chunkSize) {
            const batch = []
            const end = Math.min(size, offset + chunkSize)
            for (let rank = offset; rank < end; rank++) {
                const object = createBenchmarkRecord(rank, size, root.organization_id)
                if (!firstRecord) hash.update(',')
                hash.update(JSON.stringify(object))
                firstRecord = false
                batch.push(object)
            }
            const createStart = performance.now()
            const response = assertResponse(await send({ ...root, method: 'object.create', object: batch }), `bulk create ${offset}-${end}`)
            createAndIndexMs += performance.now() - createStart
            assert.equal(response.object.length, batch.length)
            indexEntriesPerObject ??= Object.keys(batch[0].getIndex()).length
            reportProgress(end)
        }
        hash.update(']')
        result.fixtureHash = hash.digest('hex')
        result.createAndIndexMs = createAndIndexMs
        result.createRecordsPerSecond = size / createAndIndexMs * 1000
        result.indexCreationAndMaintenance = {
            synchronous: true,
            deferredIndexing: false,
            includedInCreateAndIndexMs: true,
            flushMs: 0,
            pendingAfterCreate: db.pendingIndexCount
        }
        assert.equal(db.pendingIndexCount, 0, 'standard run must complete index maintenance before timing proceeds')
        const loadedMemory = process.memoryUsage()
        const peakRssBytes = process.resourceUsage().maxRSS * 1024
        result.memory.loaded = loadedMemory
        result.memory.peakRssBytes = peakRssBytes
        result.memory.incrementalRssBytes = loadedMemory.rss - idleMemory.rss
        result.memory.incrementalHeapBytes = loadedMemory.heapUsed - idleMemory.heapUsed
        result.memory.rssBytesPerObject = result.memory.incrementalRssBytes / size
        result.indexEntriesPerObject = indexEntriesPerObject ?? null

        const workload = standardWorkloads(size)
        const queries = [
            { key: 'uuidRead', query: null, expected: [uuidFor(Math.floor(size / 2))] },
            { key: 'equality', query: { group: workload.equality.value }, expected: expectedUuids(size, workload.equality.matches) },
            { key: 'nestedEquality', query: { 'profile.team': workload.nestedEquality.value }, expected: expectedUuids(size, workload.nestedEquality.matches) },
            { key: 'numericRange', query: { rank: { $gte: workload.numericRange.lower, $lt: workload.numericRange.upper } }, expected: expectedUuids(size, workload.numericRange.matches) },
            { key: 'and', query: { $and: [{ group: workload.and.group }, { active: workload.and.active }] }, expected: expectedUuids(size, workload.and.matches) },
            { key: 'or', query: { $or: workload.or.groups.map(group => ({ group })) }, expected: expectedUuids(size, workload.or.matches) }
        ]
        for (const item of queries) {
            const request = item.key === 'uuidRead'
                ? { ...root, method: 'object.read', object: { uuid: item.expected[0] } }
                : { ...root, method: 'object.read', filter: { query: item.query, limit: 100 } }
            verifyIds(await send(request), item.expected, `correctness ${item.key}`)
        }

        result.operations = {}
        result.operations.uuidRead = await measure(
            () => rootRead(send, root, { object: { uuid: uuidFor(Math.floor(size / 2)) } }),
            response => { assertResponse(response, 'UUID read'); assert.equal(response.object.length, 1) }, { warmups, samples })
        for (const item of queries.slice(1)) {
            result.operations[item.key] = await measure(
                () => rootRead(send, root, { filter: { query: item.query, limit: 100 } }),
                response => verifyIds(response, item.expected, item.key), { warmups, samples })
        }

        const createOffset = size + 1000 + runIndex * (warmups + samples + 100)
        let createRank = createOffset
        result.operations.singleCreate = await measure(async (stage, i) => {
            const rank = stage === 'first' ? createRank++ : createRank++
            return send({ ...root, method: 'object.create', object: createBenchmarkRecord(rank, size, root.organization_id) })
        }, response => { assertResponse(response, 'single create'); assert.equal(response.object.length, 1) }, { warmups, samples })

        const updateStart = Math.floor(size / 4)
        let updateRank = updateStart
        result.operations.singleKeyUpdate = await measure((stage, i) => {
            const rank = updateRank++
            return send({ ...root, method: 'object.update', object: { uuid: uuidFor(rank), note: `note-${stage}-${i}` } })
        }, response => { assertResponse(response, 'single key update'); assert.equal(response.object.length, 1) }, { warmups, samples })
        const indexedStart = Math.floor(size / 3)
        let indexedRank = indexedStart
        result.operations.indexedKeyUpdate = await measure((stage, i) => {
            const rank = indexedRank++
            return send({ ...root, method: 'object.update', object: { uuid: uuidFor(rank), group: `updated-group-${stage}-${i}` } })
        }, response => { assertResponse(response, 'indexed key update'); assert.equal(response.object.length, 1) }, { warmups, samples })
        result.operations.numericIncrement = await measure((stage, i) => {
            const rank = Math.floor(size / 2) + i
            return send({ ...root, method: 'object.update', object: { uuid: uuidFor(rank), '$inc.revision': 1 } })
        }, response => { assertResponse(response, 'numeric increment'); assert.equal(response.object.length, 1) }, { warmups, samples })
        const indexedCheckRank = indexedStart + warmups + samples
        const indexedValue = `updated-group-sample-${samples - 1}`
        assert.equal((await rootRead(send, root, { filter: { query: { group: indexedValue }, limit: 1 } })).object[0]?.uuid, uuidFor(indexedCheckRank))

        const deleteOffset = size + 5000 + runIndex * (warmups + samples + 100)
        const deleteIds = []
        const deletePrep = []
        for (let i = 0; i < warmups + samples + 1; i++) {
            const record = createBenchmarkRecord(deleteOffset + i, size, root.organization_id)
            deleteIds.push(record.uuid)
            deletePrep.push(record)
        }
        assert.equal(assertResponse(await send({ ...root, method: 'object.create', object: deletePrep }), 'delete prep').object.length, deletePrep.length)
        let deleteIndex = 0
        result.operations.singleDelete = await measure(() => {
            const uuid = deleteIds[deleteIndex++]
            return send({ ...root, method: 'object.delete', object: { uuid } })
        }, response => { assertResponse(response, 'single delete'); assert.equal(response.object.length, 1) }, { warmups, samples })
        for (const uuid of deleteIds) assert.equal((await rootRead(send, root, { object: { uuid } })).object.length, 0)

        const deleteQuery = { bulkDelete: true }
        const expectedDelete = Math.min(size, 25)
        const deletePrecheck = await rootRead(send, root, { filter: { query: deleteQuery, limit: 0 } })
        assert.equal(deletePrecheck.object.length, expectedDelete)
        const deleteStart = performance.now()
        const deleted = assertResponse(await send({ ...root, method: 'object.delete', filter: { query: deleteQuery, limit: 0 } }), 'filtered bulk delete')
        const filteredBulkDeleteMs = performance.now() - deleteStart
        assert.equal(deleted.object.length, expectedDelete)
        assert.equal((await rootRead(send, root, { filter: { query: deleteQuery, limit: 0 } })).object.length, 0)
        result.operations.filteredBulkDelete = { deleted: expectedDelete, elapsedMs: filteredBulkDeleteMs, opsPerSecond: expectedDelete / filteredBulkDeleteMs * 1000 }

        const sustainedIds = Array.from({ length: Math.min(size - expectedDelete, 10000) }, (_, i) => uuidFor(i))
        result.sustained = []
        for (const concurrencyLevel of concurrency) {
            for (const mode of ['read', 'write', 'mixed'])
                result.sustained.push(await sustained(send, root, sustainedIds, { durationMs: sustainMs, concurrency: concurrencyLevel, mode }))
        }

        result.cpuUsageUs = process.cpuUsage(cpuStart)
        result.totalElapsedMs = performance.now() - wallStart
        result.cpuUtilizationPercent = (result.cpuUsageUs.user + result.cpuUsageUs.system) / 1000 / result.totalElapsedMs * 100
        result.memory.final = process.memoryUsage()
        result.memory.peakRssBytes = Math.max(result.memory.peakRssBytes, process.resourceUsage().maxRSS * 1024)
        result.completedAt = new Date().toISOString()
        result.status = 'passed'
        await db.close?.()
        await writeFile(outputFile, `${JSON.stringify(result, null, 2)}\n`)
        return result
    } catch (error) {
        result.status = 'failed'
        result.failure = { name: error.name, message: error.message, stack: error.stack }
        result.completedAt = new Date().toISOString()
        result.totalElapsedMs = performance.now() - wallStart
        result.cpuUsageUs = process.cpuUsage(cpuStart)
        await writeFile(outputFile, `${JSON.stringify(result, null, 2)}\n`)
        return result
    }
}

async function orchestrate() {
    const sizes = parseStandardSizes(process.argv[2])
    const runs = Number(process.env.BENCH_RUNS ?? 5)
    const samples = Math.max(40, Number(process.env.BENCH_SAMPLES ?? 40))
    const warmups = Math.max(10, Number(process.env.BENCH_WARMUPS ?? 10))
    const sustainMs = Math.max(1000, Number(process.env.BENCH_SUSTAIN_MS ?? 5000))
    const concurrency = (process.env.BENCH_CONCURRENCY ?? '1,8').split(',').map(Number)
    const startedAt = new Date()
    const runId = startedAt.toISOString().replaceAll(':', '-')
    const outputDirectory = resolve(process.env.BENCH_OUTPUT_DIR ?? join(root, 'test/benchmarks/providers/cocreatedb/results', `standard-${runId}`))
    await mkdir(outputDirectory, { recursive: true })
    const manifest = {
        suite: 'CoCreateDB standard single-node benchmark v2', runId,
        startedAt: startedAt.toISOString(), sizes, independentRunsRequested: runs,
        sampleCount: samples, warmupCount: warmups, sustainedDurationMs: sustainMs,
        concurrencyLevels: concurrency, results: [],
        stallTimeoutMs: Number(process.env.BENCH_STALL_MS ?? 10 * 60 * 1000),
        configuration: { mode: 'adaptive', acknowledgement: 'memory', memoryPercent },
        legacyCompatibility: { status: 'not-run', fixture: 'lifecycle fixture v2', runs: [] }
    }
    let stopLargerSizes = false
    for (const size of sizes) {
        if (stopLargerSizes) {
            manifest.results.push({ size, status: 'not-attempted', reason: 'A preceding larger-than-baseline dataset failed under the recorded resource conditions.' })
            continue
        }
        let stopThisSize = false
        for (let runIndex = 1; runIndex <= runs; runIndex++) {
            const path = join(outputDirectory, `size-${size}-run-${String(runIndex).padStart(2, '0')}.json`)
            if (stopThisSize) {
                const skipped = { status: 'not-attempted', runIndex, datasetSize: size, reason: 'A preceding independent run for this size failed.' }
                await writeFile(path, `${JSON.stringify(skipped, null, 2)}\n`)
                manifest.results.push({ ...skipped, file: basename(path) })
                continue
            }
            const childResult = await launch([script, '--child', String(size), String(runIndex), path], { cwd: root, env: { ...process.env,
                BENCH_SAMPLES: String(samples), BENCH_WARMUPS: String(warmups),
                BENCH_SUSTAIN_MS: String(sustainMs), BENCH_CONCURRENCY: concurrency.join(',')
            } })
            let raw
            try { raw = JSON.parse(await readFile(path, 'utf8')) } catch {}
            const status = childResult.code === 0 && raw?.status === 'passed' ? 'passed' : 'failed'
            if (!raw) {
                const failureMessage = /heap out of memory|JavaScript heap out of memory/i.test(childResult.stderr)
                    ? 'Node.js JavaScript heap out of memory'
                    : childResult.stalled ? `Benchmark made no progress for ${childResult.stallTimeoutMs} ms`
                        : 'Benchmark subprocess exited before writing results'
                raw = {
                    status, datasetSize: size, runIndex, startedAt: new Date().toISOString(),
                    environment: recordEnvironment(),
                    failure: { message: failureMessage, exitCode: childResult.code, signal: childResult.signal, stderr: childResult.stderr },
                    stdout: childResult.stdout.slice(-2000)
                }
                await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`)
            } else if (status === 'failed') {
                raw.subprocess = { exitCode: childResult.code, signal: childResult.signal, stderr: childResult.stderr.slice(-2000) }
                await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`)
            }
            manifest.results.push({ size, runIndex, status, file: basename(path), elapsedMs: raw.totalElapsedMs, failure: raw.failure })
            console.log(`size=${size} run=${runIndex}/${runs} status=${status}${raw.failure ? ` reason=${raw.failure.message}` : ` create+index=${raw.createAndIndexMs.toFixed(2)}ms`}`)
            if (status === 'failed') {
                stopThisSize = true
                const failureText = `${raw.failure?.message ?? ''}\n${childResult.stderr}`
                stopLargerSizes = childResult.signal === 'SIGKILL' || /heap|memory|allocation|out of memory/i.test(failureText)
            }
        }
    }
    {
        const legacyCount = Math.max(0, Number(process.env.BENCH_LEGACY_RUNS ?? 0))
        if (legacyCount > 0) {
        const legacyDirectory = join(outputDirectory, 'legacy-v2')
        await mkdir(legacyDirectory, { recursive: true })
        manifest.legacyCompatibility.requestedRuns = legacyCount
        for (let runIndex = 1; runIndex <= legacyCount; runIndex++) {
            const runDirectory = join(legacyDirectory, `run-${String(runIndex).padStart(2, '0')}`)
            await mkdir(runDirectory, { recursive: true })
            const childResult = await launch([join(root, 'test/benchmarks/lifecycle.mjs'), '1000'], { cwd: root, env: {
                BENCH_SAMPLES: String(samples), BENCH_OUTPUT_DIR: runDirectory
            } })
            const files = (await readdir(runDirectory)).filter(file => file.endsWith('.json'))
            const raw = files.length === 1 ? JSON.parse(await readFile(join(runDirectory, files[0]), 'utf8')) : undefined
            const status = childResult.code === 0 && raw?.sizes?.[0]?.fixtureHash ? 'passed' : 'failed'
            manifest.legacyCompatibility.runs.push({
                runIndex, status, file: files[0] ? `legacy-v2/run-${String(runIndex).padStart(2, '0')}/${files[0]}` : null,
                fixtureHash: raw?.sizes?.[0]?.fixtureHash,
                failure: status === 'failed' ? { exitCode: childResult.code, signal: childResult.signal, stderr: childResult.stderr.slice(-2000) } : undefined
            })
        }
        manifest.legacyCompatibility.status = manifest.legacyCompatibility.runs.every(run => run.status === 'passed') ? 'passed' : 'partial'
        }
    }
    const complete = manifest.results.filter(run => run.status === 'passed').length
    const failed = manifest.results.filter(run => run.status === 'failed').length
    manifest.completedAt = new Date().toISOString()
    manifest.summary = { successfulRuns: complete, failedRuns: failed, notAttempted: manifest.results.filter(run => run.status === 'not-attempted').length }
    await writeFile(join(outputDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    console.log(`manifest=${join(outputDirectory, 'manifest.json')}`)
    console.log(`successful=${complete} failed=${failed} notAttempted=${manifest.summary.notAttempted}`)
}

if (process.argv[2] === '--child') {
    const size = Number(process.argv[3]), runIndex = Number(process.argv[4]), outputFile = resolve(process.argv[5])
    const settings = {
        samples: Math.max(40, Number(process.env.BENCH_SAMPLES ?? 40)),
        warmups: Math.max(10, Number(process.env.BENCH_WARMUPS ?? 10)),
        sustainMs: Math.max(1000, Number(process.env.BENCH_SUSTAIN_MS ?? 5000)),
        concurrency: (process.env.BENCH_CONCURRENCY ?? '1,8').split(',').map(Number)
    }
    const result = await runOne(size, runIndex, outputFile, settings)
    if (result.status !== 'passed') process.exitCode = 1
} else {
    await orchestrate()
}
