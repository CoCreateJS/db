import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createDB as createCoCreateDB } from '../../../src/object/index.js'
import { peekMemoryJSON, removeMemoryPath } from '../../../src/memory.js'
import { fileId } from '../../../src/files.js'
import { objectPath } from '../../../src/storage.js'

const require = createRequire(import.meta.url)
const { MongoClient } = require('../../../../../storages/storage-bundler/node_modules/mongodb')
const output = fileURLToPath(new URL('.', import.meta.url))
const dryRun = process.argv.includes('--dry-run')
const cocOnly = process.argv.includes('--coc-only')
let globalMongoUri
try {
    const config = await import(pathToFileURL(join(homedir(), 'CoCreate.config.js')).href)
    globalMongoUri = config.default?.persistence?.connectionString
} catch {}
const uri = process.env.MONGODB_URI || globalMongoUri
const documentCount = Number(process.env.BENCH_DOCS || 1000)
const repeatCount = Number(process.env.BENCH_REPEATS || 3)
const organization_id = '000000000000000000000001'
const common = { organization_id, storage: 'benchmark', database: 'benchmark', array: 'items' }
const host = 'benchmark.local'
const idFor = n => (n + 1).toString(16).padStart(24, '0')
const pathname = n => `/bench/item-${String(n).padStart(8, '0')}.json`
const auditTime = n => new Date(Date.UTC(2026, 0, 1) + n).toISOString()
const makeDocument = n => ({ _id: idFor(n), pathname: pathname(n), host: ['*'], rank: n,
    organization_id, group: `g${n % 32}`, revision: 0, payload: `value-${n}`,
    created: { on: auditTime(n) }, updated: { on: auditTime(n) } })
const makeNewDocument = n => ({ ...makeDocument(documentCount + n), pathname: `/bench/new-${n}.json`,
    group: 'new', payload: `new-${n}` })
const operations = [
    ['read-id', () => ({ method: 'object.read', object: { _id: idFor(0) } }),
        collection => collection.findOne({ _id: idFor(0) })],
    ['read-equality', () => ({ method: 'object.read', filter: { query: { pathname: pathname(0), host: { $in: [host, '*'] } }, limit: 1 } }),
        collection => collection.findOne({ pathname: pathname(0), host: { $in: [host, '*'] } })],
    ['read-range', () => ({ method: 'object.read', filter: { query: { rank: { $gte: 0, $lt: 20 } } } }),
        collection => collection.find({ rank: { $gte: 0, $lt: 20 } }).limit(20).toArray()],
    ['create', n => ({ method: 'object.create', object: makeNewDocument(n) }),
        (collection, n, options) => collection.insertOne(makeNewDocument(n), options)],
    ['update', n => ({ method: 'object.update', timeStamp: auditTime(n), object: { _id: idFor(0), $inc: { revision: 1 } } }),
        (collection, n, options) => collection.updateOne({ _id: idFor(0) }, { $inc: { revision: 1 }, $set: { updated: { on: auditTime(n) } } }, options)]
]

function assertResponse(response, label) {
    if (response?.success === false || (Array.isArray(response?.error) ? response.error.length : response?.error))
        throw new Error(`${label} CoCreateDB operation failed`)
}

const timed = async operation => {
    const start = performance.now()
    const value = await operation()
    return { elapsedMs: performance.now() - start, value }
}

async function measure(label, call, beforeCall) {
    await beforeCall?.(0)
    const first = await timed(() => call(0))
    const subsequent = []
    for (let i = 0; i < repeatCount; i++) {
        await beforeCall?.(i + 1)
        subsequent.push((await timed(() => call(i + 1))).elapsedMs)
    }
    return { operation: label, firstCallMs: first.elapsedMs, subsequentCallMs: subsequent,
        subsequentAverageMs: subsequent.reduce((sum, ms) => sum + ms, 0) / subsequent.length,
        subsequentCount: subsequent.length }
}

async function createCoC(directory, mode) {
    return createCoCreateDB({ directory, memoryCache: true, memoryOnly: mode === 'memory',
        disk: true, writeBehind: mode === 'deferred', externalPersistence: false,
        persistenceOptions: mode === 'deferred' ? { debounceMs: 60_000, maxWaitMs: 60_000 } : {} })
}

async function seedCoC(db) {
    let firstFileId
    for (let n = 0; n < documentCount; n++) {
        const response = await db.send({ ...common, method: 'object.create', object: makeDocument(n) })
        assertResponse(response, 'Seed')
        if (n === 0) firstFileId = fileId(response.object?.[0])
        if (n % 64 === 0) await new Promise(resolve => setImmediate(resolve))
    }
    await db.flush()
    return firstFileId
}

async function runCoC(mode) {
    const directory = await mkdtemp(join(tmpdir(), `coc-direct-${mode}-`))
    let db
    const results = []
    let seedMs
    try {
        db = await createCoC(directory, mode)
        let start = performance.now()
        await seedCoC(db)
        seedMs = performance.now() - start
        for (const [label, makePayload] of operations) {
            const result = await measure(label, async n => {
                const response = await db.send({ ...common, ...makePayload(n) })
                assertResponse(response, label)
                if (label === 'read-id' && response.object?.[0]?._id !== idFor(0)) throw new Error('ID read mismatch')
                if (label === 'read-equality' && response.object?.[0]?._id !== idFor(0)) throw new Error('Equality read mismatch')
                if (label === 'read-range' && response.object?.length !== 20) throw new Error('Range read mismatch')
                return response
            })
            if (mode === 'deferred' && ['create', 'update'].includes(label)) {
                const flushStart = performance.now()
                await db.flush()
                result.deferredFlushMs = performance.now() - flushStart
            }
            results.push(result)
        }
        return { backend: `cocreate-${mode}`, seedMs, results }
    } finally {
        await db?.close()
        removeMemoryPath(directory)
        await rm(directory, { recursive: true, force: true })
    }
}

async function runCoCOsPageCacheRead() {
    const directory = await mkdtemp(join(tmpdir(), 'coc-direct-os-cache-'))
    let db
    try {
        db = await createCoC(directory, 'deferred')
        const start = performance.now()
        const firstFileId = await seedCoC(db)
        const setupMs = performance.now() - start
        if (!firstFileId) throw new Error('Could not locate seeded object file identity')
        const file = objectPath(directory, 'unused', 'unused', firstFileId)

        // Warm Linux/OS file cache via native filesystem I/O, without populating
        // CoCreateDB's JSON cache. Then evict only this record before every sample.
        removeMemoryPath(file)
        const cacheStart = performance.now()
        const warmed = JSON.parse(await readFile(file, 'utf8'))
        const osPageCacheWarmMs = performance.now() - cacheStart
        if (warmed._id !== idFor(0)) throw new Error('OS page-cache fixture read mismatch')
        const evictObjectFromProcessCache = () => {
            removeMemoryPath(file)
            if (peekMemoryJSON(file) !== undefined) throw new Error('Could not evict CoCreateDB object from process cache')
        }

        const result = await measure('read-id-os-page-cache', async () => {
            const response = await db.send({ ...common, method: 'object.read', object: { _id: idFor(0) } })
            assertResponse(response, 'OS page-cache read')
            if (response.object?.[0]?._id !== idFor(0)) throw new Error('OS page-cache ID read mismatch')
            return response
        }, evictObjectFromProcessCache)
        return { backend: 'cocreate-os-page-cache-read', seedMs: setupMs, osPageCacheWarmMs,
            cacheState: 'object absent from CoCreateDB memory before each measured read; file pre-read through native fs to warm OS page cache', results: [result] }
    } finally {
        await db?.close()
        removeMemoryPath(directory)
        await rm(directory, { recursive: true, force: true })
    }
}

async function runMongo(client, databaseName, durability) {
    const database = client.db(databaseName)
    const results = []
    let seedMs
    try {
        const collection = database.collection('items')
        const writeOptions = durability === 'journal' ? { writeConcern: { w: 1, j: true } } : { writeConcern: { w: 1, j: false } }
        const start = performance.now()
        await collection.insertMany(Array.from({ length: documentCount }, (_, n) => makeDocument(n)), { ordered: true })
        for (const key of ['pathname', 'host', 'rank', 'group', 'revision', 'payload', 'organization_id', 'created.on', 'updated.on'])
            await collection.createIndex({ [key]: 1 })
        seedMs = performance.now() - start
        for (const [label, , mongoCall] of operations) {
            const result = await measure(label, async n => {
                const value = await mongoCall(collection, n, writeOptions)
                if (label === 'read-id' && value?._id !== idFor(0)) throw new Error('MongoDB ID read mismatch')
                if (label === 'read-equality' && value?._id !== idFor(0)) throw new Error('MongoDB equality read mismatch')
                if (label === 'read-range' && value?.length !== 20) throw new Error('MongoDB range read mismatch')
                if (label === 'create' && !value?.acknowledged) throw new Error('MongoDB create was not acknowledged')
                if (label === 'update' && value?.matchedCount !== 1) throw new Error('MongoDB update did not match one document')
                return value
            })
            results.push(result)
        }
        return { backend: `mongodb-${durability}`, seedMs, results }
    } finally {
        await database.dropDatabase()
    }
}

function renderReport(result, comparison) {
    const mongo = result.backends.find(backend => backend.backend === 'mongodb-memory-ack')
    const lines = [mongo ? '# Direct CoCreateDB and MongoDB operation latency' : '# Direct CoCreateDB operation latency', '',
        `Seed documents: ${result.documentCount}. Subsequent samples per operation: ${result.repeatCount}.`,
        'First-call latency is reported separately. Subsequent average is the arithmetic mean of only the subsequent calls.',
        'CoCreateDB calls use in-process db.send() with no HTTP, Socket, or CRUD server routing. Its foreground responses reflect local memory state; peer delivery and disk persistence are separate background work.',
        'CoCreateDB write-behind creates also check _id uniqueness through the local index/read path; this is part of the current foreground create timing.',
        'The CoCreateDB OS-page-cache read pre-reads the object file through native filesystem I/O, clears only the CoCreateDB object cache, then measures db.send() reads while evicting the object cache before each sample. OS page cache is warmed best-effort; the OS does not expose a per-file cache guarantee here.',
        'CoCreateDB deferred flush timing is reported separately. db.flush() waits for pending index work and the deferred filesystem-write queue; it does not request fsync/crash durability.',
        '',
        '## Setup time (excluded from operation latency)', '',
        '| Backend | Seed and index setup ms |', '|---|---:|']
    if (mongo) {
        lines.splice(6, 0, 'MongoDB calls use the Node driver directly; driver/server communication remains included. MongoDB memory acknowledgment uses explicit {w:1,j:false}; journal acknowledgment uses {w:1,j:true}.')
        lines.splice(8, 0, 'MongoDB reads are warmed by fixture seeding/index setup, but the service does not expose which layer served them (WiredTiger cache, OS page cache, or storage).')
        const flushDescription = lines.findIndex(line => line.startsWith('CoCreateDB deferred flush timing'))
        lines[flushDescription] += ' MongoDB j:true waits for on-disk journal acknowledgment.'
    }
    for (const backend of result.backends) lines.push(`| ${backend.backend} | ${backend.seedMs.toFixed(1)} |`)
    lines.push('',
        '| Backend | Operation | First call ms | Subsequent average ms | Subsequent samples ms |',
        '|---|---|---:|---:|---|')
    for (const backend of result.backends) for (const row of backend.results)
        lines.push(`| ${backend.backend} | ${row.operation} | ${row.firstCallMs.toFixed(3)} | ${row.subsequentAverageMs.toFixed(3)} | ${row.subsequentCallMs.map(ms => ms.toFixed(3)).join(', ')} |`)
    if (comparison) {
        lines.push('', '## CoCreateDB run-to-run comparison', '',
            `Current run: ${result.startedAt}. Previous run: ${comparison.startedAt}. Positive changes mean the current latency is higher; percentages are relative to the previous subsequent-sample average.`, '',
            '| CoCreateDB path | Operation | Previous average ms | Current average ms | Change ms | Change % |',
            '|---|---|---:|---:|---:|---:|')
        for (const backend of result.backends.filter(item => item.backend.startsWith('cocreate-'))) {
            const previous = comparison.backends.find(item => item.backend === backend.backend)
            if (!previous) continue
            for (const row of backend.results) {
                const old = previous.results.find(item => item.operation === row.operation)
                if (!old) continue
                const delta = row.subsequentAverageMs - old.subsequentAverageMs
                const percent = delta / old.subsequentAverageMs * 100
                lines.push(`| ${backend.backend} | ${row.operation} | ${old.subsequentAverageMs.toFixed(3)} | ${row.subsequentAverageMs.toFixed(3)} | ${delta >= 0 ? '+' : ''}${delta.toFixed(3)} | ${percent >= 0 ? '+' : ''}${percent.toFixed(1)}% |`)
            }
        }
    }
    if (mongo) {
        const coc = result.backends.find(backend => backend.backend === 'cocreate-memory')
        lines.push('', '## Foreground subsequent average: CoCreateDB local memory vs MongoDB memory acknowledgment', '',
            'A negative latency delta means CoCreateDB took less time; a positive delta means it took more time. MongoDB still includes driver, wire protocol, and server round-trip.', '',
            '| Operation | MongoDB w:1,j:false ms | CoCreateDB memory ms | CoCreateDB latency delta |',
            '|---|---:|---:|---:|')
        const fmtDelta = value => `${value < 0 ? '' : '+'}${value.toFixed(1)}%`
        for (const mongoRow of mongo.results) {
            const memoryRow = coc.results.find(row => row.operation === mongoRow.operation)
            lines.push(`| ${mongoRow.operation} | ${mongoRow.subsequentAverageMs.toFixed(3)} | ${memoryRow.subsequentAverageMs.toFixed(3)} | ${fmtDelta((memoryRow.subsequentAverageMs / mongoRow.subsequentAverageMs - 1) * 100)} |`)
        }
    }
    const osCache = result.backends.find(backend => backend.backend === 'cocreate-os-page-cache-read')
    if (osCache) {
        const mongoId = result.backends.find(backend => backend.backend === 'mongodb-memory-ack')?.results.find(row => row.operation === 'read-id')
        lines.push('', '## CoCreateDB warm OS page-cache read', '',
            `CoCreateDB cache warm-up read: ${osCache.osPageCacheWarmMs.toFixed(3)} ms. Before each timed sample, only the CoCreateDB object record is evicted from process memory; the OS page cache is left intact. The fixture/index setup took ${osCache.seedMs.toFixed(1)} ms.`, '')
        const row = osCache.results[0]
        if (mongoId) {
            lines.push('MongoDB is shown as a reference only: it includes a client/server round-trip and its cache source is unknown.', '',
                '| Read path | First call ms | Subsequent average ms | Delta vs MongoDB mean | Subsequent samples ms |', '|---|---:|---:|---:|---|')
            const deltaValue = (row.subsequentAverageMs / mongoId.subsequentAverageMs - 1) * 100
            const delta = `${deltaValue < 0 ? '' : '+'}${deltaValue.toFixed(1)}%`
            lines.push(`| CoCreateDB process-cache miss, OS-page-cache warm | ${row.firstCallMs.toFixed(3)} | ${row.subsequentAverageMs.toFixed(3)} | ${delta} | ${row.subsequentCallMs.map(ms => ms.toFixed(3)).join(', ')} |`)
            lines.push(`| MongoDB warmed fixture read (cache layer unknown) | — | ${mongoId.subsequentAverageMs.toFixed(3)} | — | ${mongoId.subsequentCallMs.map(ms => ms.toFixed(3)).join(', ')} |`)
        } else {
            lines.push('| Read path | First call ms | Subsequent average ms | Subsequent samples ms |', '|---|---:|---:|---|',
                `| CoCreateDB process-cache miss, OS-page-cache warm | ${row.firstCallMs.toFixed(3)} | ${row.subsequentAverageMs.toFixed(3)} | ${row.subsequentCallMs.map(ms => ms.toFixed(3)).join(', ')} |`)
        }
    }
    const deferred = result.backends.find(backend => backend.backend === 'cocreate-deferred')
    if (deferred) {
        lines.push('', '## CoCreateDB deferred persistence drain', '',
            '| Operation batch | Foreground subsequent average ms | Flush after measured calls ms |', '|---|---:|---:|')
        for (const row of deferred.results.filter(row => row.deferredFlushMs !== undefined))
            lines.push(`| ${row.operation} | ${row.subsequentAverageMs.toFixed(3)} | ${row.deferredFlushMs.toFixed(3)} |`)
    }
    const journal = result.backends.find(backend => backend.backend === 'mongodb-journal')
    if (journal) {
        lines.push('', '## MongoDB journal acknowledgment', '', '| Operation | MongoDB w:1,j:false ms | MongoDB w:1,j:true ms |', '|---|---:|---:|')
        const memoryAck = result.backends.find(backend => backend.backend === 'mongodb-memory-ack')
        for (const row of journal.results.filter(item => ['create', 'update'].includes(item.operation))) {
            const noJournal = memoryAck.results.find(item => item.operation === row.operation)
            lines.push(`| ${row.operation} | ${noJournal.subsequentAverageMs.toFixed(3)} | ${row.subsequentAverageMs.toFixed(3)} |`)
        }
    }
    lines.push('', 'No deletes are included. Setup/seed time is recorded separately and excluded from operation latency.', '')
    return lines.join('\n')
}

const reportOnlyIndex = process.argv.indexOf('--report-only')
const compareIndex = process.argv.indexOf('--compare-to')
const comparePath = compareIndex < 0 ? undefined : process.argv[compareIndex + 1]
if (compareIndex >= 0 && !comparePath) throw new Error('Provide a saved benchmark JSON path after --compare-to')
const comparison = comparePath ? JSON.parse(await readFile(comparePath, 'utf8')) : undefined
if (reportOnlyIndex !== -1) {
    const jsonPath = process.argv[reportOnlyIndex + 1]
    if (!jsonPath) throw new Error('Provide a saved benchmark JSON path after --report-only')
    const result = JSON.parse(await readFile(jsonPath, 'utf8'))
    const reportPath = jsonPath.replace(/\.json$/, '.md')
    await writeFile(reportPath, renderReport(result, comparison) + '\n')
    console.log(`Report: ${reportPath}`)
} else if (dryRun) {
    console.log(JSON.stringify({ plan: 'direct database operation latency', documentCount, repeatCount,
        backends: cocOnly ? ['cocreate-memory', 'cocreate-deferred', 'cocreate-os-page-cache-read'] : ['cocreate-memory', 'cocreate-deferred', 'cocreate-os-page-cache-read', 'mongodb-memory-ack', 'mongodb-journal'],
        operations: operations.map(([name]) => name), comparisonRun: comparison?.startedAt, mongoUriConfigured: Boolean(uri) }, null, 2))
} else {
    if (!Number.isSafeInteger(documentCount) || documentCount < 20 || !Number.isSafeInteger(repeatCount) || repeatCount < 1)
        throw new Error('BENCH_DOCS must be >= 20 and BENCH_REPEATS must be >= 1')
    if (!cocOnly && !uri) throw new Error('Set MONGODB_URI to run the MongoDB comparison; use --coc-only for the CoCreateDB measurements alone')
    const result = { startedAt: new Date().toISOString(), documentCount, repeatCount, backends: [] }
    let client
    const databaseName = `cocb_${Date.now().toString(36)}_${process.pid.toString(36)}`
    try {
        result.backends.push(await runCoC('memory'))
        result.backends.push(await runCoC('deferred'))
        result.backends.push(await runCoCOsPageCacheRead())
        if (!cocOnly) {
            client = new MongoClient(uri, { appName: 'cocreate-direct-benchmark', maxPoolSize: 1 })
            try { await client.connect() }
            catch { throw new Error('MongoDB connection failed; connection details were suppressed') }
            result.backends.push(await runMongo(client, `${databaseName}_m`, 'memory-ack'))
            result.backends.push(await runMongo(client, `${databaseName}_j`, 'journal'))
        }
    } finally {
        await client?.close()
    }
    result.finishedAt = new Date().toISOString()
    const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
    const jsonPath = join(output, `run-${stamp}.json`)
    const reportPath = join(output, `run-${stamp}.md`)
    await writeFile(jsonPath, JSON.stringify(result, null, 2) + '\n')
    await writeFile(reportPath, renderReport(result, comparison) + '\n')
    console.log(renderReport(result, comparison))
    console.log(`\nJSON: ${jsonPath}\nReport: ${reportPath}`)
}
