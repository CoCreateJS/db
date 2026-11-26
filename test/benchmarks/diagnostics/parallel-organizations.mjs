import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir, totalmem } from 'node:os'
import Disk from '@cocreate/disk'
import { createDB } from '../../../src/index.js'
import { benchmarkUuid, createBenchmarkRecord, lifecycleRoot } from '../../fixtures/lifecycle.mjs'
import { waitForIndex } from '../shared/wait-for-index.mjs'

const size = Number(process.argv[2] ?? 100000)
if (!Number.isSafeInteger(size) || size < 1) throw Error('Records per organization must be a positive integer')
const runId = new Date().toISOString().replaceAll(':', '-')
const output = resolve(process.env.BENCH_OUTPUT_DIR ?? `test/benchmarks/providers/cocreatedb/results/parallel-organizations-${size}-${runId}`)
await mkdir(output, { recursive: true })
const directory = await mkdtemp(join(tmpdir(), 'cocreatedb-parallel-organizations-'))
const result = {
    status: 'running', startedAt: new Date().toISOString(), recordsPerOrganization: size,
    totalRecords: size * 2, batchSize: 1000,
    processModel: 'one primary DB process, two concurrent ingestion loops, two organization Trees, one disk adapter with separate organization directories',
    node: process.version, totalMemoryBytes: totalmem(),
    configuration: { mode: 'adaptive', memoryPercent: 25, telemetry: 'process RSS every 100ms' },
    organizations: []
}
let db, telemetry, progress
const checked = response => {
    assert.equal(response.success, true, response.error?.join('; '))
    return response
}
try {
    const disk = await Disk.init({ directory })
    const server = new EventEmitter()
    server.id = 'parallel-organizations-benchmark'
    server.isPrimary = true
    db = await createDB(server, { disk, size: 64 })
    const sample = () => server.emit('telemetry', { data: {
        serverId: server.id, workerId: 0, timestamp: new Date().toISOString(),
        memory: { total: totalmem(), max: process.memoryUsage().rss / totalmem() * 100 }
    } })
    sample()
    telemetry = setInterval(sample, 100)
    const states = await Promise.all([1, 2].map(async number => {
        const root = { ...lifecycleRoot(size), organization_id: number.toString(16).padStart(24, '0') }
        return { root, tree: await db.organization.get(root.organization_id), number }
    }))
    result.memory = { idle: process.memoryUsage() }
    const start = performance.now()
    progress = setInterval(() => console.log(`BENCH_PROGRESS elapsedMs=${Math.round(performance.now() - start)} ${states.map(state => `org${state.number}Pending=${state.tree.pendingIndexCount}`).join(' ')} rssMiB=${Math.round(process.memoryUsage().rss / 1048576)}`), 10000)
    await Promise.all(states.map(async state => {
        const { root, tree, number } = state
        const stats = { organization_id: root.organization_id, records: size, acknowledgementMs: 0, fixtureGenerationMs: 0 }
        result.organizations.push(stats)
        const hash = createHash('sha256')
        for (let offset = 0; offset < size; offset += 1000) {
            const generation = performance.now()
            const values = Array.from({ length: Math.min(1000, size - offset) }, (_, i) => createBenchmarkRecord(offset + i, size, root.organization_id))
            hash.update(JSON.stringify(values))
            stats.fixtureGenerationMs += performance.now() - generation
            const before = performance.now()
            const response = checked(await db.send({ ...root, method: 'object.create', object: values }))
            stats.acknowledgementMs += performance.now() - before
            assert.equal(response.object.length, values.length)
            const completed = offset + values.length
            if (completed % 10000 === 0 || completed === size) console.log(`BENCH_PROGRESS org=${number} acknowledged=${completed}/${size} elapsedMs=${Math.round(performance.now() - start)}`)
        }
        stats.fixtureHash = hash.digest('hex')
        stats.allAcknowledgedAtMs = performance.now() - start
        stats.pendingAfterAcknowledgement = tree.pendingIndexCount
        const drain = performance.now()
        await waitForIndex(tree, { timeoutMs: 1200000, progressMs: 0 })
        stats.remainingIndexDrainMs = performance.now() - drain
        stats.createAndIndexMs = performance.now() - start
        stats.pendingAfterIndexing = tree.pendingIndexCount
    }))
    result.createAndIndexMs = performance.now() - start
    result.allAcknowledgedAtMs = Math.max(...result.organizations.map(stats => stats.allAcknowledgedAtMs))
    result.recordsPerSecond = size * 2 / result.createAndIndexMs * 1000
    result.memory.loaded = process.memoryUsage()
    result.memory.peakRssBytes = process.resourceUsage().maxRSS * 1024
    clearInterval(progress)
    for (const { root } of states) {
        const read = checked(await db.send({ ...root, method: 'object.read', object: { uuid: benchmarkUuid(0) } }))
        assert.equal(read.object.length, 1)
        assert.equal(read.object[0].organization_id, root.organization_id)
        const indexed = checked(await db.send({ ...root, method: 'object.read', filter: { query: { group: 'group-3' }, limit: 100 } }))
        assert.equal(indexed.object.length, Math.min(100, Math.floor((size + 6) / 10)))
        assert.ok(indexed.object.every(leaf => leaf.organization_id === root.organization_id && leaf.group === 'group-3'))
        const files = await readdir(join(directory, root.organization_id, 'leaves'))
        const stats = result.organizations.find(stats => stats.organization_id === root.organization_id)
        stats.leafFiles = files.filter(file => file.endsWith('.json')).length
        assert.ok(stats.leafFiles >= size)
    }
    checked(await db.send({ ...states[0].root, method: 'object.update', object: { uuid: benchmarkUuid(0), '$inc.revision': 1 } }))
    for (const { root, number } of states) {
        const read = checked(await db.send({ ...root, method: 'object.read', object: { uuid: benchmarkUuid(0) } }))
        assert.equal(read.object[0].revision, number === 1 ? 1 : 0)
    }
    checked(await db.send({ ...states[0].root, method: 'object.delete', object: { uuid: benchmarkUuid(0) } }))
    assert.equal(checked(await db.send({ ...states[0].root, method: 'object.read', object: { uuid: benchmarkUuid(0) } })).object.length, 0)
    assert.equal(checked(await db.send({ ...states[1].root, method: 'object.read', object: { uuid: benchmarkUuid(0) } })).object.length, 1)
    await waitForIndex(db, { timeoutMs: 1200000, progressMs: 10000 })
    result.correctness = { uuidReads: 'passed', indexedReads: 'passed', separateDirectories: 'passed', updateAndDeleteIsolation: 'passed' }
    result.telemetry = { ...db.memory }
    await db.close()
    db = undefined
    result.status = 'passed'
} catch (error) {
    result.status = 'failed'
    result.failure = { message: error.message, stack: error.stack }
    process.exitCode = 1
} finally {
    clearInterval(telemetry)
    clearInterval(progress)
    if (db) await db.close().catch(error => { result.closeError = error.message })
    result.completedAt = new Date().toISOString()
    await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n')
    await writeFile(join(output, 'report.md'), `# Parallel organization benchmark\n\nStatus: ${result.status}. One process, two concurrent organization Trees, ${size.toLocaleString()} records each.\n\n| Organization | Acknowledged at (s) | Remaining index drain (s) | Create + index (s) |\n| --- | ---: | ---: | ---: |\n${result.organizations.map(row => `| ${row.organization_id} | ${(row.allAcknowledgedAtMs / 1000).toFixed(2)} | ${(row.remainingIndexDrainMs / 1000).toFixed(2)} | ${(row.createAndIndexMs / 1000).toFixed(2)} |`).join('\n')}\n\nCombined create/index wall time: ${(result.createAndIndexMs / 1000).toFixed(2)} s. Throughput: ${result.recordsPerSecond?.toFixed(0)} records/s. Peak process RSS: ${(result.memory?.peakRssBytes / 1048576).toFixed(1)} MiB.\n\nPer-organization timings overlap and must not be summed. Telemetry, disk writes and indexing share the process. This diagnostic does not include the standard sustained workloads. Correctness checks: ${JSON.stringify(result.correctness ?? result.failure)}.\n`)
    await rm(directory, { recursive: true, force: true })
}
console.log(JSON.stringify({ status: result.status, createAndIndexMs: result.createAndIndexMs, recordsPerSecond: result.recordsPerSecond, output, failure: result.failure }))
