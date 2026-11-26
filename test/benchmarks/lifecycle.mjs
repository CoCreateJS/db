import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { join, resolve } from 'node:path'
import { createRuntime } from '../../src/runtime.js'
import { createLifecycleFixture, createLifecycleRecord, lifecycleFixtureHash, lifecycleQueries, lifecycleRoot } from '../fixtures/lifecycle.mjs'

const sizes = process.argv[2]?.split(',').map(Number) ?? [1000]
const samples = Number(process.env.BENCH_SAMPLES ?? 40)
const startedAt = new Date()
const results = {
    benchmark: 'cocreatedb-next-object-lifecycle-memory',
    fixture: 'shared deterministic lifecycle fixture v2',
    startedAt: startedAt.toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    cpuCount: availableParallelism(),
    mode: 'in-memory prototype; synchronous indexing; no peer or durable persistence latency',
    samples,
    sizes: []
}

const percentile = (values, fraction) => {
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]
}
const measure = async (fn, count = samples) => {
    const coldStart = performance.now()
    await fn('cold', 0)
    const coldMs = performance.now() - coldStart
    const values = []
    for (let i = 0; i < Math.min(10, count); i++) await fn(i)
    const measuredStart = performance.now()
    for (let i = 0; i < count; i++) {
        const start = performance.now()
        await fn(i)
        values.push(performance.now() - start)
    }
    const elapsedMs = performance.now() - measuredStart
    return {
        coldMs,
        p50Ms: percentile(values, 0.5),
        p95Ms: percentile(values, 0.95),
        p99Ms: percentile(values, 0.99),
        meanMs: values.reduce((sum, value) => sum + value, 0) / values.length,
        opsPerSecond: count / elapsedMs * 1000
    }
}
const assertSuccess = (response, label) => {
    if (!response || response.success === false)
        throw Error(`${label} failed: ${response?.error?.join('; ') ?? 'no response'}`)
    return response
}
const assertCount = (response, count, label) => {
    assertSuccess(response, label)
    if (response.object?.length !== count)
        throw Error(`${label}: expected ${count}, got ${response.object?.length ?? 'no result'}`)
    return response
}

for (const size of sizes) {
    const root = lifecycleRoot(size)
    const seed = await createRuntime()
    const seedResponse = await seed.send({ ...root, method: 'object.create', object: { uuid: 'seed-only', rank: -1 } })
    assert.equal(seedResponse.success, true)
    const config = JSON.parse(JSON.stringify(seed.config))
    const restored = process.env.BENCH_MODE === 'restored'
    const initStart = performance.now()
    const db = await createRuntime(undefined, restored ? { config } : { config: {} })
    const initMs = performance.now() - initStart
    const beforeConfig = JSON.parse(JSON.stringify(db.config))
    assert.equal(Object.keys(beforeConfig.leaves).length, restored ? 4 : 0)
    if (restored) assert.deepEqual(beforeConfig, config)
    assert.equal((await db.send({ method: 'object.read', object: { uuid: 'seed-only' } })).object.length, 0)
    const send = (method, extra = {}) => db.send({ ...root, method: `object.${method}`, ...extra })
    const documents = createLifecycleFixture(size)
    const fixtureHash = lifecycleFixtureHash(documents)
    const queries = lifecycleQueries(size)
    const cpu = process.cpuUsage()
    const wallStart = performance.now()
    try {
        const createStart = performance.now()
        assertCount(await send('create', { object: documents }), size, 'object.create batch')
        const createBatchMs = performance.now() - createStart
        const afterConfig = JSON.parse(JSON.stringify(db.config))
        assert.equal(Object.keys(afterConfig.leaves).length, 4)
        if (restored) {
            assert.deepEqual(afterConfig, config)
            assert.ok(documents.every(doc => doc.parent === seedResponse.object[0].parent))
        } else {
            assert.notEqual(documents[0].parent, seedResponse.object[0].parent)
        }
        const createRecordsPerSecond = size / createBatchMs * 1000
        // This implementation indexes synchronously as part of object.create.
        const indexFlushMs = 0
        const selected = documents[queries.selectedRank]
        const readUuid = await measure(async () =>
            assertCount(await send('read', { object: { uuid: selected.uuid } }), 1, 'UUID read'))
        const readEquality = await measure(async () =>
            assertCount(await send('read', { filter: { query: queries.equality.query, limit: 0 } }), queries.equality.count, 'equality read'))
        const readNested = await measure(async () =>
            assertCount(await send('read', { filter: { query: queries.nested.query, limit: 0 } }), queries.nested.count, 'nested read'))
        const readRange = await measure(async () =>
            assertCount(await send('read', { filter: { query: queries.range.query, limit: 0 } }), queries.range.count, 'range read'))
        const updateUuid = await measure(async (i, coldIndex) => {
            const item = documents[(coldIndex ?? i) % documents.length]
            assertSuccess(await send('update', { object: { uuid: item.uuid, $update: { $inc: { revision: 1 } } } }), 'UUID update')
        })
        const updateIndexFlushMs = 0
        const deleteCount = Math.min(25, size)
        const deleteStart = performance.now()
        assertCount(await send('delete', {
            object: documents.slice(0, deleteCount).map(({ uuid }) => ({ uuid }))
        }), deleteCount, 'UUID delete batch')
        const deleteMs = performance.now() - deleteStart
        const deleteIndexFlushMs = 0
        for (const { uuid } of documents.slice(0, deleteCount))
            assertCount(await send('read', { object: { uuid } }), 0, 'deleted UUID read')

        const fresh = createLifecycleRecord(size, root.organization_id)
        const freshCreateStart = performance.now()
        assertCount(await send('create', { object: fresh }), 1, 'post-create object.create')
        const freshCreateMs = performance.now() - freshCreateStart
        const firstReadStart = performance.now()
        assertCount(await send('read', { object: { uuid: fresh.uuid } }), 1, 'post-create UUID read')
        const firstReadMs = performance.now() - firstReadStart
        const firstUpdateStart = performance.now()
        assertSuccess(await send('update', {
            object: { uuid: fresh.uuid, $update: { $inc: { revision: 1 } } }
        }), 'post-create UUID update')
        const firstUpdateMs = performance.now() - firstUpdateStart

        results.sizes.push({
            size,
            scenario: restored ? "restored" : "fresh",
            initMs,
            rootIdentities: Object.keys(afterConfig.leaves).length,
            parentUuid: documents[0].parent,
            fixtureHash,
            createBatchMs,
            createAndIndexMs: createBatchMs,
            createRecordsPerSecond,
            indexEntriesPerRecord: Object.keys(await documents[0].getIndex()).length,
            indexFlushMs,
            readUuid,
            readEquality,
            readNestedPath: readNested,
            readRange,
            updateUuid,
            updateIndexFlushMs,
            postCreate: { createMs: freshCreateMs, firstReadMs, firstUpdateMs,
                createToReadMs: freshCreateMs + firstReadMs,
                createToUpdateMs: freshCreateMs + firstUpdateMs },
            deleteBatch: { count: deleteCount, elapsedMs: deleteMs, indexFlushMs: deleteIndexFlushMs,
                totalMs: deleteMs, recordsPerSecond: deleteCount / deleteMs * 1000 },
            cpuUsageUs: process.cpuUsage(cpu),
            wallMs: performance.now() - wallStart,
            memory: process.memoryUsage()
        })
        console.log(`size=${size} create+index=${createBatchMs.toFixed(2)}ms uuid-p50=${readUuid.p50Ms.toFixed(3)}ms range-p50=${readRange.p50Ms.toFixed(3)}ms fixture=${fixtureHash}`)
    } finally {
        await db.close?.()
    }
}

results.completedAt = new Date().toISOString()
const outputDirectory = resolve(process.env.BENCH_OUTPUT_DIR ?? 'test/benchmarks/providers/cocreatedb/results/legacy-v2')
await mkdir(outputDirectory, { recursive: true })
const output = join(outputDirectory, `run-${startedAt.toISOString().replaceAll(':', '-')}.json`)
await writeFile(output, `${JSON.stringify(results, null, 2)}\n`)
console.log(`results=${output}`)
