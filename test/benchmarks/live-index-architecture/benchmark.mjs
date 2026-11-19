import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { availableParallelism, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createDB } from '../../../src/index.js'
import { removeMemoryPath } from '../../../src/memory.js'
import { flattenIndexValues } from '../../../src/storage.js'

const size = Number(process.argv[2] ?? 1000)
const requestedCardinality = process.argv[3]
const samples = Number(process.env.BENCH_SAMPLES ?? 40)
const cardinalities = requestedCardinality ? [requestedCardinality] : ['unique', 'high', 'low']
if (cardinalities.some(value => !['unique', 'high', 'low'].includes(value)))
    throw new TypeError('Cardinality must be unique, high, or low')
const startedAt = new Date()
const result = {
    benchmark: 'cocreatedb-live-index-architecture',
    startedAt: startedAt.toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    cpuCount: availableParallelism(),
    samples,
    size,
    mode: 'memoryOnly: true; one process; no peer or external persistence latency',
    distributions: []
}

const percentile = (values, fraction) => {
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]
}
const measure = async fn => {
    const values = []
    for (let i = 0; i < Math.min(samples, 10); i++) await fn(i)
    for (let i = 0; i < samples; i++) {
        const start = performance.now()
        await fn(i)
        values.push(performance.now() - start)
    }
    return {
        p50Ms: percentile(values, 0.5),
        p95Ms: percentile(values, 0.95),
        p99Ms: percentile(values, 0.99),
        meanMs: values.reduce((sum, value) => sum + value, 0) / values.length
    }
}
const assertSuccess = (response, label) => {
    assert.ok(response && response.success !== false, `${label}: ${response?.error?.join('; ') ?? 'no response'}`)
    return response
}
const assertCount = (response, expected, label) => {
    assertSuccess(response, label)
    assert.equal(response.object?.length, expected, `${label} result count`)
    return response
}
const captureMemory = () => {
    global.gc?.()
    const { rss, heapUsed, heapTotal, external } = process.memoryUsage()
    return { rssBytes: rss, heapUsedBytes: heapUsed, heapTotalBytes: heapTotal, externalBytes: external }
}

for (const cardinality of cardinalities) {
    const directory = await mkdtemp(join(tmpdir(), `coc-db-live-${cardinality}-`))
    const organization_id = randomBytes(12).toString('hex')
    const scope = { organization_id, storage: 'bench', database: 'app', array: 'records' }
    const db = createDB({ directory, memoryOnly: true, nodeId: 'benchmark' })
    const send = (method, extra = {}) => db.send({ ...scope, method: `object.${method}`, ...extra })

    try {
        for (const request of [
            { method: 'storage.create', storage: { name: scope.storage } },
            { method: 'database.create', database: { name: scope.database } },
            { method: 'array.create', array: { name: scope.array } }
        ]) assertSuccess(await db.send({ ...scope, ...request }), request.method)

        const documents = Array.from({ length: size }, (_, rank) => ({
            bucket: cardinality === 'unique' ? `bucket-${rank}`
                : cardinality === 'high' ? `bucket-${rank % Math.ceil(size / 10)}`
                    : `bucket-${rank % 10}`,
            rank,
            profile: { team: `team-${rank % 20}`, score: rank % 100 },
            tags: [`tag-${rank % 5}`, `tag-${(rank + 1) % 5}`],
            revision: 0
        }))
        const createStart = performance.now()
        assertSuccess(await send('create', { object: documents }), 'object.create')
        const createAckMs = performance.now() - createStart
        const flushStart = performance.now()
        await db.flush()
        const indexFlushMs = performance.now() - flushStart
        const memoryAfterIndex = captureMemory()
        const selected = documents[Math.floor(size / 2)]
        const bucketCount = documents.filter(document => document.bucket === selected.bucket).length
        const nestedCount = documents.filter(document => document.profile.team === selected.profile.team).length
        const lower = Math.floor(size * 0.4), upper = Math.ceil(size * 0.6)
        const rangeCount = documents.filter(document => document.rank >= lower && document.rank < upper).length

        const uuidRead = await measure(async () => assertCount(
            await send('read', { object: { uuid: selected.uuid } }), 1, 'UUID read'))
        const equalityRead = await measure(async () => assertCount(
            await send('read', { filter: { query: { bucket: selected.bucket }, limit: 0 } }), bucketCount, 'bucket equality'))
        const nestedRead = await measure(async () => assertCount(
            await send('read', { filter: { query: { 'profile.team': selected.profile.team }, limit: 0 } }), nestedCount, 'nested equality'))
        const rangeRead = await measure(async () => assertCount(
            await send('read', { filter: { query: { rank: { $gte: lower, $lt: upper } }, limit: 0 } }), rangeCount, 'rank range'))

        const updateUuid = await measure(async i => {
            const document = documents[i % documents.length]
            assertSuccess(await send('update', {
                object: { uuid: document.uuid, $update: { $inc: { revision: 1 } } }
            }), 'UUID update')
        })
        await db.flush()
        const deleteCount = Math.min(25, size)
        const deleteStart = performance.now()
        assertSuccess(await send('delete', {
            object: documents.slice(0, deleteCount).map(({ uuid }) => ({ uuid }))
        }), 'UUID delete batch')
        const deleteBatchMs = performance.now() - deleteStart
        await db.flush()
        for (const document of documents.slice(0, deleteCount))
            assertCount(await send('read', { object: { uuid: document.uuid } }), 0, 'deleted UUID read')

        result.distributions.push({ cardinality, documents: size,
            indexedEntriesPerDocument: flattenIndexValues(documents[0]).length,
            distinctBucketValues: new Set(documents.map(document => document.bucket)).size,
            matchingBucketCount: bucketCount, createAckMs, indexFlushMs, memoryAfterIndex,
            uuidRead, equalityRead, nestedRead, rangeRead, updateUuid,
            deleteBatch: { count: deleteCount, elapsedMs: deleteBatchMs },
            memoryAfterCrud: captureMemory() })
        console.log(`${cardinality}: create=${createAckMs.toFixed(2)}ms flush=${indexFlushMs.toFixed(2)}ms equality=${equalityRead.p50Ms.toFixed(3)}ms range=${rangeRead.p50Ms.toFixed(3)}ms`)
    } finally {
        await db.close()
        removeMemoryPath(directory)
        await rm(directory, { recursive: true, force: true })
    }
}

result.completedAt = new Date().toISOString()
const outputDirectory = resolve('test/benchmarks/live-index-architecture/results')
await mkdir(outputDirectory, { recursive: true })
const output = join(outputDirectory, `run-${startedAt.toISOString().replaceAll(':', '-')}.json`)
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`)
console.log(`results=${output}`)
