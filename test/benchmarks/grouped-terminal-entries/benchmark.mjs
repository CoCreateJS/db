import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { availableParallelism, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createIndex } from '../../../src/index/index.js'
import { enableMemoryCache, memoryEntries, removeMemoryPath } from '../../../src/memory.js'

const cardinalities = [
    { name: 'unique', values: size => Array.from({ length: size }, (_, i) => i) },
    { name: 'high', values: size => Array.from({ length: size }, (_, i) => Math.floor(i / 3)) },
    { name: 'low', values: size => Array.from({ length: size }, (_, i) => i % 10) }
]
const size = Number(process.argv[2] ?? 3000)
const samples = Number(process.env.BENCH_SAMPLES ?? 50)
const output = {
    benchmark: 'cocreatedb-terminal-entry-cardinality',
    startedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    cpuCount: availableParallelism(),
    size,
    samples,
    results: []
}
const percentile = (values, fraction) => {
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]
}
const measure = async operation => {
    const times = []
    for (let i = 0; i < samples; i++) {
        const start = performance.now()
        await operation(i)
        times.push(performance.now() - start)
    }
    return { p50Ms: percentile(times, .5), p95Ms: percentile(times, .95), meanMs: times.reduce((a, b) => a + b, 0) / times.length }
}
const collect = async iterable => {
    const entries = []
    for await (const entry of iterable) entries.push(entry)
    return entries
}

for (const { name, values: makeValues } of cardinalities) {
    const directory = await mkdtemp(join(tmpdir(), 'coc-grouped-index-'))
    enableMemoryCache(directory, { memoryOnly: true })
    const index = createIndex({ directory, maxBytes: 128 * 1024 })
    const values = makeValues(size)
    const uuids = Array.from({ length: size }, (_, i) => `uuid-${String(i).padStart(8, '0')}`)
    try {
        const insertStart = performance.now()
        await index.batch(async () => {
            for (let i = 0; i < size; i++) await index.create('db', name, 'value', values[i], uuids[i])
        })
        const insertMs = performance.now() - insertStart
        const serializedBytes = memoryEntries(directory).reduce((total, [path, node]) =>
            total + (path.includes('/indexes/') ? Buffer.byteLength(JSON.stringify(node)) : 0), 0)
        const equalityValue = values[Math.floor(size / 2)]
        const matching = values.filter(value => value === equalityValue).length
        const equality = await measure(async () => {
            const found = await collect(index.scan('db', name, 'value', { type: 'number', lower: equalityValue, upper: equalityValue }))
            if (found.length !== matching) throw Error(`${name} equality returned ${found.length}, expected ${matching}`)
        })
        const maximum = values.at(-1)
        const lower = Math.floor(maximum * .4), upper = Math.floor(maximum * .6) + 1
        const expectedRange = values.filter(value => value >= lower && value < upper).length
        const range = await measure(async () => {
            const found = await collect(index.scan('db', name, 'value', { type: 'number', lower, upper: upper - 1 }))
            if (found.length !== expectedRange) throw Error(`${name} range returned ${found.length}, expected ${expectedRange}`)
        })
        const spliceIds = Array.from({ length: samples }, (_, i) => `insert-${String(i).padStart(8, '0')}`)
        const insertUuid = await measure(async i => {
            await index.create('db', name, 'value', equalityValue, spliceIds[i])
        })
        for (const id of spliceIds)
            await index.delete('db', name, 'value', equalityValue, id)
        const update = await measure(async i => {
            const at = i % size
            await index.delete('db', name, 'value', values[at], uuids[at])
            await index.create('db', name, 'value', values[at], uuids[at])
        })
        const remove = await measure(async i => {
            const at = size - 1 - i
            await index.delete('db', name, 'value', values[at], uuids[at])
        })
        output.results.push({
            cardinality: name,
            insertMs,
            equality,
            range,
            insertUuid,
            updateUuid: update,
            deleteUuid: remove,
            serializedIndexBytes: serializedBytes
        })
        console.log(`${name}: insert=${insertMs.toFixed(1)}ms equality=${equality.p50Ms.toFixed(3)}ms range=${range.p50Ms.toFixed(3)}ms bytes=${serializedBytes}`)
    } finally {
        removeMemoryPath(directory)
        await rm(directory, { recursive: true, force: true })
    }
}

output.completedAt = new Date().toISOString()
const resultsDirectory = resolve('test/benchmarks/grouped-terminal-entries/results')
await mkdir(resultsDirectory, { recursive: true })
const file = join(resultsDirectory, `run-${output.startedAt.replaceAll(':', '-')}.json`)
await writeFile(file, `${JSON.stringify(output, null, 2)}\n`)
console.log(`results=${file}`)
