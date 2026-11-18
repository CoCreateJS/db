import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { availableParallelism, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createDB } from '../../../src/index.js'
import { removeMemoryPath } from '../../../src/memory.js'

const sizes = process.argv[2]?.split(',').map(Number) ?? [100, 500, 1000]
const samples = Number(process.env.BENCH_SAMPLES ?? 40)
const now = new Date()
const results = {
    benchmark: 'cocreatedb-scoped-lifecycle-memory',
    startedAt: now.toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    cpuCount: availableParallelism(),
    mode: 'memoryOnly: true; one process; no peer or external persistence latency',
    samples,
    sizes: []
}

const percentile = (values, fraction) => {
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]
}
const measure = async (fn, count = samples) => {
    const values = []
    for (let i = 0; i < Math.min(10, count); i++) await fn(i)
    for (let i = 0; i < count; i++) {
        const start = performance.now()
        await fn(i)
        values.push(performance.now() - start)
    }
    return { p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95), p99Ms: percentile(values, 0.99), meanMs: values.reduce((a, b) => a + b, 0) / values.length }
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
            rank,
            group: `group-${rank % 10}`,
            profile: { team: `team-${rank % 20}`, score: rank % 100 },
            tags: [`tag-${rank % 5}`, `tag-${(rank + 1) % 5}`],
            revision: 0
        }))
        const createStart = performance.now()
        assertSuccess(await send('create', { object: documents }), 'object.create batch')
        const createMs = performance.now() - createStart
        const indexStart = performance.now()
        await db.flush()
        const indexMs = performance.now() - indexStart
        const selected = documents[ Math.floor(size / 2) ]
        const equalityCount = documents.filter(item => item.group === 'group-3').length
        const nestedCount = documents.filter(item => item.profile.team === 'team-7').length
        const lower = Math.floor(size * 0.4), upper = Math.floor(size * 0.6)
        const rangeCount = documents.filter(item => item.rank >= lower && item.rank < upper).length
        const readUuid = await measure(async () => assertCount(await send('read', { object: { uuid: selected.uuid } }), 1, 'UUID read'))
        const readEquality = await measure(async () => assertCount(await send('read', { filter: { query: { group: 'group-3' }, limit: 0 } }), equalityCount, 'equality read'))
        const readNested = await measure(async () => assertCount(await send('read', { filter: { query: { 'profile.team': 'team-7' }, limit: 0 } }), nestedCount, 'nested read'))
        const readRange = await measure(async () => assertCount(await send('read', { filter: { query: { rank: { $gte: lower, $lt: upper } }, limit: 0 } }), rangeCount, 'range read'))
        const update = await measure(async i => {
            const item = documents[i % documents.length]
            assertSuccess(await send('update', { object: { uuid: item.uuid, $update: { $inc: { revision: 1 } } } }), 'UUID update')
        })
        await db.flush()
        const deleteCount = Math.min(25, size)
        const deleteStart = performance.now()
        assertSuccess(await send('delete', { object: documents.slice(0, deleteCount).map(({ uuid }) => ({ uuid })) }), 'UUID delete batch')
        const deleteMs = performance.now() - deleteStart
        await db.flush()
        for (const item of documents.slice(0, deleteCount))
            assertCount(await send('read', { object: { uuid: item.uuid } }), 0, 'deleted UUID read')
        results.sizes.push({ size, createBatchMs: createMs, indexFlushMs: indexMs, readUuid, readEquality,
            readNestedPath: readNested, readRange, updateUuid: update, deleteBatch: { count: deleteCount, elapsedMs: deleteMs } })
        console.log(`size=${size} create=${createMs.toFixed(2)}ms index=${indexMs.toFixed(2)}ms uuid-read-p50=${readUuid.p50Ms.toFixed(3)}ms nested-p50=${readNested.p50Ms.toFixed(3)}ms`)
    } finally {
        await db.close()
        removeMemoryPath(directory)
        await rm(directory, { recursive: true, force: true })
    }
}

results.completedAt = new Date().toISOString()
const outputDirectory = resolve('test/benchmarks/db-lifecycle-20261118/results')
await mkdir(outputDirectory, { recursive: true })
const output = join(outputDirectory, `run-${now.toISOString().replaceAll(':', '-')}.json`)
await writeFile(output, `${JSON.stringify(results, null, 2)}\n`)
console.log(`results=${output}`)
