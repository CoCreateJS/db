import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { availableParallelism, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createDB } from '../../../src/index.js'
import { removeMemoryPath } from '../../../src/memory.js'
import { flattenIndexValues } from '../../../src/storage.js'
import { createLifecycleFixture, createLifecycleRecord, lifecycleFixtureHash, lifecycleQueries, lifecycleScope } from '../../fixtures/lifecycle.mjs'

const sizes = process.argv[2]?.split(',').map(Number) ?? [1000]
const samples = Number(process.env.BENCH_SAMPLES ?? 40)
const now = new Date()
const results = {
    benchmark: 'cocreatedb-scoped-lifecycle-memory',
    startedAt: now.toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    cpuCount: availableParallelism(),
    fixture: 'shared deterministic lifecycle fixture v2',
    mode: 'memoryOnly: true; one process; no peer or external persistence latency',
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
    return { coldMs, p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95), p99Ms: percentile(values, 0.99),
        meanMs: values.reduce((a, b) => a + b, 0) / values.length, opsPerSecond: count / elapsedMs * 1000 }
}
const assertSuccess = (response, label) => {
    if (!response || response.success === false) throw Error(`${label} failed: ${response?.error?.join('; ') ?? 'no response'}`)
    return response
}
const assertCount = (response, expected, label) => {
    assertSuccess(response, label)
    if (response.object?.length !== expected)
        throw Error(`${label} returned ${response.object?.length ?? 'no'} records; expected ${expected}`)
    return response
}

for (const size of sizes) {
    const directory = await mkdtemp(join(tmpdir(), 'coc-db-bench-'))
    const scope = lifecycleScope(size)
    const db = createDB({ directory, memoryOnly: true, nodeId: 'benchmark' })
    const send = (method, extra = {}) => db.send({ ...scope, method: `object.${method}`, ...extra })
    try {
        for (const request of [
            { method: 'storage.create', storage: { name: scope.storage } },
            { method: 'database.create', database: { name: scope.database } },
            { method: 'array.create', array: { name: scope.array } }
        ]) assertSuccess(await db.send({ ...scope, ...request }), request.method)

        const documents = createLifecycleFixture(size)
        const queries = lifecycleQueries(size)
        const cpu = process.cpuUsage()
        const wallStart = performance.now()
        const createStart = performance.now()
        assertSuccess(await send('create', { object: documents }), 'object.create batch')
        const createMs = performance.now() - createStart
        const indexStart = performance.now()
        await db.flush()
        const indexMs = performance.now() - indexStart
        const createAndIndexMs = createMs + indexMs
        const createRecordsPerSecond = size / createAndIndexMs * 1000
        const selected = documents[queries.selectedRank]
        const readUuid = await measure(async () => assertCount(await send('read', { object: { uuid: selected.uuid } }), 1, 'UUID read'))
        const readEquality = await measure(async () => assertCount(await send('read', { filter: { query: queries.equality.query, limit: 0 } }), queries.equality.count, 'equality read'))
        const readNested = await measure(async () => assertCount(await send('read', { filter: { query: queries.nested.query, limit: 0 } }), queries.nested.count, 'nested read'))
        const readRange = await measure(async () => assertCount(await send('read', { filter: { query: queries.range.query, limit: 0 } }), queries.range.count, 'range read'))
        const update = await measure(async (i, coldIndex) => {
            const item = documents[(coldIndex ?? i) % documents.length]
            assertSuccess(await send('update', { object: { uuid: item.uuid, $update: { $inc: { revision: 1 } } } }), 'UUID update')
        })
        const updateFlushStart = performance.now()
        await db.flush()
        const updateIndexFlushMs = performance.now() - updateFlushStart
        const deleteCount = Math.min(25, size)
        const deleteStart = performance.now()
        assertSuccess(await send('delete', { object: documents.slice(0, deleteCount).map(({ uuid }) => ({ uuid })) }), 'UUID delete batch')
        const deleteMs = performance.now() - deleteStart
        const deleteFlushStart = performance.now()
        await db.flush()
        const deleteIndexFlushMs = performance.now() - deleteFlushStart
        for (const item of documents.slice(0, deleteCount))
            assertCount(await send('read', { object: { uuid: item.uuid } }), 0, 'deleted UUID read')
        const fresh = createLifecycleRecord(size, scope.organization_id)
        const freshCreateStart = performance.now()
        assertSuccess(await send('create', { object: fresh }), 'post-create object.create')
        const freshCreateMs = performance.now() - freshCreateStart
        const firstReadStart = performance.now()
        assertCount(await send('read', { object: { uuid: fresh.uuid } }), 1, 'post-create UUID read')
        const firstReadMs = performance.now() - firstReadStart
        const firstUpdateStart = performance.now()
        assertSuccess(await send('update', {
            object: { uuid: fresh.uuid, $update: { $inc: { revision: 1 } } }
        }), 'post-create UUID update')
        const firstUpdateMs = performance.now() - firstUpdateStart
        const postCreateFlushStart = performance.now()
        await db.flush()
        const postCreateIndexFlushMs = performance.now() - postCreateFlushStart
        results.sizes.push({ size, fixtureHash: lifecycleFixtureHash(createLifecycleFixture(size)), createBatchMs: createMs,
            indexFlushMs: indexMs, createAndIndexMs, createRecordsPerSecond,
            indexEntriesPerRecord: flattenIndexValues(documents[0]).length, readUuid, readEquality,
            readNestedPath: readNested, readRange, updateUuid: update, updateIndexFlushMs,
            postCreate: { createMs: freshCreateMs, firstReadMs, firstUpdateMs,
                createToReadMs: freshCreateMs + firstReadMs,
                createToUpdateMs: freshCreateMs + firstUpdateMs,
                pendingIndexFlushMs: postCreateIndexFlushMs },
            deleteBatch: { count: deleteCount, elapsedMs: deleteMs, indexFlushMs: deleteIndexFlushMs,
                totalMs: deleteMs + deleteIndexFlushMs, recordsPerSecond: deleteCount / (deleteMs + deleteIndexFlushMs) * 1000 },
            cpuUsageUs: process.cpuUsage(cpu), wallMs: performance.now() - wallStart,
            memory: process.memoryUsage() })
        console.log(`size=${size} create+index=${createAndIndexMs.toFixed(2)}ms uuid-cold=${readUuid.coldMs.toFixed(3)}ms uuid-warm-p50=${readUuid.p50Ms.toFixed(3)}ms range-warm-p50=${readRange.p50Ms.toFixed(3)}ms fixture=${lifecycleFixtureHash(createLifecycleFixture(size))}`)
    } finally {
        await db.close()
        removeMemoryPath(directory)
        await rm(directory, { recursive: true, force: true })
    }
}

results.completedAt = new Date().toISOString()
const outputDirectory = resolve(process.env.BENCH_OUTPUT_DIR ?? 'test/benchmarks/db-lifecycle-20261118/results')
await mkdir(outputDirectory, { recursive: true })
const output = join(outputDirectory, `run-${now.toISOString().replaceAll(':', '-')}.json`)
await writeFile(output, `${JSON.stringify(results, null, 2)}\n`)
console.log(`results=${output}`)
