import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import createDB from '../../../src/index.js'
import { benchmarkUuid, createBenchmarkRecord, lifecycleRoot } from '../../fixtures/lifecycle.mjs'
import { launch } from '../shared/child-process.mjs'

const script = fileURLToPath(import.meta.url)
const repo = resolve(dirname(script), '../../..')
const resultRoot = join(repo, 'test/benchmarks/diagnostics/results')
const percentile = (values, ratio) => {
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)] ?? 0
}
const median = values => percentile(values, 0.5)
const gitRevision = () => {
    try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim() }
    catch { return null }
}
const bytes = value => `${(value / 1024 / 1024).toFixed(2)} MiB`

async function runOne(size, runIndex, outputFile, uuidMode) {
    const startedAt = new Date()
    const root = lifecycleRoot(size)
    const batchSize = 1000
    const warmups = 10
    const samples = 40
    const memoryPercent = Number(process.env.BENCH_MEMORY_PERCENT ?? 75)
    const generatedUuid = uuidMode === 'generated'
    const makeRecord = rank => {
        const record = createBenchmarkRecord(rank, size, root.organization_id)
        if (generatedUuid) delete record.uuid
        return record
    }
    const directory = await mkdtemp(join(tmpdir(), `cocreatedb-create-ack-${runIndex}-`))
    const result = {
        status: 'running', benchmark: 'cocreatedb-create-acknowledgement-diagnostic',
        benchmarkVersion: 1, fixture: 'shared lifecycle fixture v3', fixtureVersion: '3.0.0',
        datasetSize: size, runIndex, batchSize, warmups, samples, uuidMode,
        configuration: { mode: 'adaptive', acknowledgement: 'memory', memoryPercent, deferIndex: true },
        sourceRevision: gitRevision(), startedAt: startedAt.toISOString()
    }
    const hash = createHash('sha256')
    hash.update('[')
    let first = true
    let lastCreatedUuid
    let db
    const say = value => process.stdout.write(`BENCH_PROGRESS provider=cocreate-ack run=${runIndex} ${value}\n`)

    try {
        db = await createDB.init(undefined, {
            prompt: false, directory, config: { memory: memoryPercent }, size: 64, deferIndex: true
        })
        const send = request => db.send(request)

        // Seed and finish its index first so the measured fixture starts from a ready tree.
        const seed = {
            uuid: `ack-seed-${runIndex}-${size}`, _id: `ack-seed-${runIndex}-${size}`,
            rank: -1, group: 'seed', active: false, createdAt: '2020-01-01T00:00:00.000Z',
            profile: { team: 'seed', score: 0, location: { region: 'seed', verified: false } },
            tags: [], payload: 'seed', bulkDelete: false, revision: 0
        }
        const seedResponse = await send({ ...root, method: 'object.create', object: seed })
        assert.equal(seedResponse.success, true, JSON.stringify(seedResponse.error))
        await db.flushIndex()

        const singleCreateTimes = []
        let singleCreateAcknowledgementMs = 0
        for (let i = 0; i < warmups + samples; i++) {
            const record = makeRecord(size + i)
            const before = performance.now()
            const response = await send({ ...root, method: 'object.create', object: record })
            const elapsed = performance.now() - before
            assert.equal(response.success, true, JSON.stringify(response.error))
            assert.equal(typeof response.object[0]?.uuid, 'string')
            if (!generatedUuid) assert.equal(response.object[0].uuid, record.uuid)
            if (i >= warmups) {
                singleCreateTimes.push(elapsed)
                singleCreateAcknowledgementMs += elapsed
            }
        }
        result.singleCreateAcknowledgement = {
            acknowledgedCreates: samples,
            elapsedMs: singleCreateAcknowledgementMs,
            opsPerSecond: samples / singleCreateAcknowledgementMs * 1000,
            latencyMs: {
                p50: percentile(singleCreateTimes, 0.5),
                p95: percentile(singleCreateTimes, 0.95),
                p99: percentile(singleCreateTimes, 0.99)
            },
            pendingLeavesBeforeDrain: db.pendingIndexCount
        }
        const singleDrainStart = performance.now()
        await db.flushIndex()
        result.singleCreateAcknowledgement.indexDrainMs = performance.now() - singleDrainStart
        assert.equal(db.pendingIndexCount, 0)

        let preparationMs = 0
        let requestAcknowledgementMs = 0
        const requestLatencies = []
        const phaseStart = performance.now()
        for (let offset = 0; offset < size; offset += batchSize) {
            const end = Math.min(size, offset + batchSize)
            const preparationStart = performance.now()
            const records = Array.from({ length: end - offset }, (_, i) => {
                const record = makeRecord(offset + i)
                if (!first) hash.update(',')
                hash.update(JSON.stringify(record))
                first = false
                return record
            })
            preparationMs += performance.now() - preparationStart

            const requestStart = performance.now()
            const response = await send({ ...root, method: 'object.create', object: records })
            const elapsed = performance.now() - requestStart
            requestAcknowledgementMs += elapsed
            requestLatencies.push(elapsed)
            assert.equal(response.success, true, JSON.stringify(response.error))
            assert.equal(response.object.length, records.length)
            const ids = response.object.map(record => record.uuid)
            assert.ok(ids.every(id => typeof id === 'string' && id.length > 0))
            assert.equal(new Set(ids).size, ids.length)
            lastCreatedUuid = ids.at(-1)
            if (!generatedUuid) {
                assert.equal(response.object[0]?.uuid, benchmarkUuid(offset))
                assert.equal(response.object.at(-1)?.uuid, benchmarkUuid(end - 1))
            }
            if (end % 10_000 === 0 || end === size) say(`created=${end}/${size} pendingIndex=${db.pendingIndexCount}`)
        }
        hash.update(']')
        result.fixtureHash = hash.digest('hex')
        result.bulkCreateAcknowledgement = {
            acknowledgedRecords: size,
            requests: requestLatencies.length,
            requestAcknowledgementMs,
            acknowledgementOpsPerSecond: size / requestAcknowledgementMs * 1000,
            requestLatencyMs: {
                p50: percentile(requestLatencies, 0.5),
                p95: percentile(requestLatencies, 0.95),
                p99: percentile(requestLatencies, 0.99)
            },
            fixturePreparationMs: preparationMs,
            pendingLeavesAfterAcknowledgement: db.pendingIndexCount
        }

        const directReadStart = performance.now()
        const lastUuid = generatedUuid ? lastCreatedUuid : benchmarkUuid(size - 1)
        const directRead = await send({ ...root, method: 'object.read', object: { uuid: lastUuid } })
        result.uuidReadBeforeIndexMs = performance.now() - directReadStart
        assert.equal(directRead.success, true, JSON.stringify(directRead.error))
        assert.equal(directRead.object.length, 1)
        assert.equal(directRead.object[0].uuid, lastUuid)

        const drainStart = performance.now()
        await db.flushIndex()
        result.indexDrainAfterAcknowledgementMs = performance.now() - drainStart
        result.pendingLeavesAfterIndexDrain = db.pendingIndexCount
        result.createToIndexedWallMs = performance.now() - phaseStart
        result.createToIndexedWallExcludingFixturePreparationMs = Math.max(0, result.createToIndexedWallMs - preparationMs)
        assert.equal(result.pendingLeavesAfterIndexDrain, 0)
        if (!generatedUuid) assert.equal(result.fixtureHash, '79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b')

        result.memory = process.memoryUsage()
        result.peakRssBytes = process.resourceUsage().maxRSS * 1024
        result.cpuUsageUs = process.cpuUsage()
        result.completedAt = new Date().toISOString()
        result.status = 'passed'
        say(`indexed=${size}/${size} ackMs=${requestAcknowledgementMs.toFixed(2)} drainMs=${result.indexDrainAfterAcknowledgementMs.toFixed(2)}`)
    } catch (error) {
        result.status = 'failed'
        result.failure = { name: error.name, message: error.message, stack: error.stack }
        result.completedAt = new Date().toISOString()
    } finally {
        if (db) {
            try { await db.flushDisk?.() }
            catch (error) { result.cleanupFailure = error.message; result.status = 'failed' }
            await db.close?.()
        }
        await mkdir(dirname(outputFile), { recursive: true })
        await writeFile(outputFile, `${JSON.stringify(result, null, 2)}\n`)
        await rm(directory, { recursive: true, force: true })
    }
    return result
}

async function orchestrate(size, uuidMode) {
    const runs = Number(process.env.BENCH_RUNS ?? 5)
    if (!Number.isSafeInteger(runs) || runs < 1) throw Error('BENCH_RUNS must be a positive integer')
    const startedAt = new Date()
    const runId = startedAt.toISOString().replaceAll(':', '-')
    const output = resolve(process.env.BENCH_OUTPUT_DIR ?? join(resultRoot, `create-acknowledgement-${uuidMode}-${size}-${runId}`))
    await mkdir(output, { recursive: true })
    const manifest = {
        benchmark: 'CoCreateDB deferred create acknowledgement and index drain',
        benchmarkVersion: 1, runId, startedAt: startedAt.toISOString(), datasetSize: size,
        fixture: `shared lifecycle fixture v3 (${uuidMode} UUIDs)`, fixtureHash: uuidMode === 'supplied' ? '79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b' : null,
        uuidMode, runsRequested: runs, configuration: { mode: 'adaptive', acknowledgement: 'memory', memoryPercent: Number(process.env.BENCH_MEMORY_PERCENT ?? 75), deferIndex: true },
        sourceRevision: gitRevision(), sourceWorkingTreeDirty: execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim().length > 0,
        sourceHashes: {}, results: []
    }
    for (const file of ['src/node/index.js', 'src/root.js', 'src/leaf.js', 'test/fixtures/lifecycle.mjs', 'test/benchmarks/diagnostics/create-acknowledgement.mjs']) {
        manifest.sourceHashes[file] = createHash('sha256').update(await readFile(join(repo, file))).digest('hex')
    }
    for (let runIndex = 1; runIndex <= runs; runIndex++) {
        const file = `run-${String(runIndex).padStart(2, '0')}.json`
        const outputFile = join(output, file)
        const child = await launch([script, '--child', String(size), String(runIndex), outputFile, uuidMode], { cwd: repo })
        let result
        try { result = JSON.parse(await readFile(outputFile, 'utf8')) } catch {}
        const status = child.code === 0 && result?.status === 'passed' ? 'passed' : 'failed'
        if (result && status !== result.status) result.subprocess = { exitCode: child.code, signal: child.signal, stderr: child.stderr }
        manifest.results.push({ runIndex, file, status, failure: result?.failure })
        process.stdout.write(`run=${runIndex}/${runs} status=${status}${result?.failure ? ` reason=${result.failure.message}` : ` ack=${result.bulkCreateAcknowledgement?.requestAcknowledgementMs.toFixed(2)}ms index-drain=${result.indexDrainAfterAcknowledgementMs?.toFixed(2)}ms`}\n`)
        if (status !== 'passed') break
    }
    const passed = manifest.results.filter(result => result.status === 'passed')
    const results = await Promise.all(passed.map(async item => JSON.parse(await readFile(join(output, item.file), 'utf8'))))
    manifest.fixtureHash = results[0]?.fixtureHash ?? null
    const fields = [
        ['singleCreateAckP50Ms', result => result.singleCreateAcknowledgement.latencyMs.p50],
        ['singleCreateAckP95Ms', result => result.singleCreateAcknowledgement.latencyMs.p95],
        ['singleCreateIndexDrainMs', result => result.singleCreateAcknowledgement.indexDrainMs],
        ['bulkCreateAcknowledgementMs', result => result.bulkCreateAcknowledgement.requestAcknowledgementMs],
        ['bulkCreateAcknowledgementOpsPerSecond', result => result.bulkCreateAcknowledgement.acknowledgementOpsPerSecond],
        ['bulkIndexDrainAfterAcknowledgementMs', result => result.indexDrainAfterAcknowledgementMs],
        ['bulkCreateToIndexedWallMs', result => result.createToIndexedWallMs],
        ['bulkCreateToIndexedWallExcludingFixturePreparationMs', result => result.createToIndexedWallExcludingFixturePreparationMs],
        ['pendingLeavesAfterAcknowledgement', result => result.bulkCreateAcknowledgement.pendingLeavesAfterAcknowledgement],
        ['peakRssBytes', result => result.peakRssBytes]
    ]
    manifest.summary = Object.fromEntries(fields.map(([key, select]) => [key, median(results.map(select))]))
    manifest.completedAt = new Date().toISOString()
    await writeFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    const report = [
        '# CoCreateDB Create Acknowledgement and Index Drain', '',
        `- Run: ${runId}; passed ${passed.length}/${runs}.`,
        `- Fixture: shared lifecycle fixture v3 with ${uuidMode} UUIDs, ${size}; hash is recorded per run.`,
        `- Mode: adaptive; acknowledgement: memory; memory allocation: ${manifest.configuration.memoryPercent}%; deferred tree indexing enabled.`,
        '- Each trial uses a fresh Node process and isolated temporary DB directory. Values are medians across independent trials.',
        '- Create acknowledgement measures elapsed time awaiting `object.create` responses. Index drain measures the remaining `flushIndex()` time after the create responses; background indexing may already have progressed during creation.',
        '- The benchmark verifies the last created leaf can be read directly by UUID before the index drain finishes.',
        '- `createLeaf()` currently constructs its per-key Entry metadata synchronously; this measures deferred tree insertion, not a leaf-only implementation.',
        '',
        '| Metric | Median |', '| --- | ---: |',
        `| Single create acknowledgement p50 | ${manifest.summary.singleCreateAckP50Ms.toFixed(3)} ms |`,
        `| Single create acknowledgement p95 | ${manifest.summary.singleCreateAckP95Ms.toFixed(3)} ms |`,
        `| Single create index drain | ${manifest.summary.singleCreateIndexDrainMs.toFixed(3)} ms |`,
        `| ${size.toLocaleString()} create acknowledgement requests | ${manifest.summary.bulkCreateAcknowledgementMs.toFixed(3)} ms |`,
        `| ${size.toLocaleString()} acknowledgement throughput | ${Math.round(manifest.summary.bulkCreateAcknowledgementOpsPerSecond).toLocaleString()} records/s |`,
        `| Pending leaves after acknowledgement | ${Math.round(manifest.summary.pendingLeavesAfterAcknowledgement).toLocaleString()} |`,
        `| Remaining index drain after acknowledgement | ${manifest.summary.bulkIndexDrainAfterAcknowledgementMs.toFixed(3)} ms |`,
        `| Create to fully indexed wall time | ${manifest.summary.bulkCreateToIndexedWallMs.toFixed(3)} ms |`,
        `| Peak RSS | ${bytes(manifest.summary.peakRssBytes)} |`,
        '',
        'Fixture preparation is timed separately and excluded from acknowledgement request time. Index work can overlap with the create loop, so acknowledgement time and post-ack drain are separate phases, not additive estimates of total index CPU time.',
        '', 'Raw per-run results and source hashes are in this directory.'
    ].join('\n') + '\n'
    await writeFile(join(output, 'report.md'), report)
    process.stdout.write(`report=${join(output, 'report.md')}\n`)
    if (passed.length !== runs) process.exitCode = 1
}

if (process.argv[2] === '--child') {
    const size = Number(process.argv[3])
    const runIndex = Number(process.argv[4])
    const outputFile = process.argv[5]
    const uuidMode = process.argv[6] ?? 'supplied'
    if (!Number.isSafeInteger(size) || size < 1 || !Number.isSafeInteger(runIndex) || !outputFile || !['supplied', 'generated'].includes(uuidMode)) throw Error('Invalid child benchmark arguments')
    const result = await runOne(size, runIndex, outputFile, uuidMode)
    if (result.status !== 'passed') process.exitCode = 1
} else {
    const size = Number(process.argv[2] ?? 100_000)
    if (!Number.isSafeInteger(size) || size < 1) throw Error('Size must be a positive integer')
    const uuidMode = process.argv[3] ?? 'supplied'
    if (!['supplied', 'generated'].includes(uuidMode)) throw Error('UUID mode must be supplied or generated')
    await orchestrate(size, uuidMode)
}
