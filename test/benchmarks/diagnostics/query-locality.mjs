import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, statfs, writeFile } from 'node:fs/promises'
import { totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import createDB from '../../../src/index.js'

const { values } = parseArgs({ options: {
    mode: { type: 'string', default: 'focused' },
    records: { type: 'string', default: '100000' },
    requests: { type: 'string', default: '12000' },
    'batch-size': { type: 'string', default: '64' },
    'leaf-size': { type: 'string', default: '1024' },
    'gc-every': { type: 'string', default: '0' },
    'idle-ms': { type: 'string', default: '60000' },
    'final-idle-ms': { type: 'string', default: '180000' },
    fields: { type: 'string', default: '42' },
    'focused-fields': { type: 'string', default: '4' },
    memory: { type: 'string', default: '25' },
    'database-mode': { type: 'string' },
    acknowledgement: { type: 'string', default: 'memory' }
} })
const { mode } = values
const records = Number(values.records), requests = Number(values.requests)
const fieldCount = Number(values.fields), focusedCount = Number(values['focused-fields'])
const memory = Number(values.memory), batchSize = Number(values['batch-size'])
const branchSize = 1024, leafSize = Number(values['leaf-size'])
const gcEvery = Number(values['gc-every'])
const idleMs = Number(values['idle-ms']), finalIdleMs = Number(values['final-idle-ms'])
const rssLimitMiB = Number(process.env.BENCH_RSS_LIMIT_MIB ?? 4600)
const databaseMode = values['database-mode'] ?? 'adaptive'
const acknowledgement = values.acknowledgement
assert.ok(['focused', 'scattered'].includes(mode), '--mode must be focused or scattered')
assert.ok(Number.isSafeInteger(records) && records >= 100, '--records must be at least 100')
assert.ok(Number.isSafeInteger(requests) && requests >= 20, '--requests must be at least 20')
assert.ok(Number.isSafeInteger(fieldCount) && fieldCount > 3, '--fields must be at least 4')
assert.ok(Number.isSafeInteger(focusedCount) && focusedCount >= 1 && focusedCount <= 4 && focusedCount <= fieldCount - 2,
    '--focused-fields must be 1–4 and leave room for revision and payload')
assert.ok(Number.isSafeInteger(batchSize) && batchSize > 0, '--batch-size must be positive')
assert.ok(Number.isSafeInteger(idleMs) && idleMs >= 0, '--idle-ms must be nonnegative')
assert.ok(Number.isSafeInteger(finalIdleMs) && finalIdleMs >= 0, '--final-idle-ms must be nonnegative')
assert.ok(Number.isSafeInteger(gcEvery) && gcEvery >= 0, '--gc-every must be zero or a positive record count')
assert.ok(Number.isSafeInteger(leafSize) && leafSize >= 2, '--leaf-size must be at least 2')
assert.ok(memory > 0 && memory <= 100, '--memory must be between 0 and 100')
assert.ok(Number.isFinite(rssLimitMiB) && rssLimitMiB > 0, 'BENCH_RSS_LIMIT_MIB must be positive')
assert.ok(['adaptive', 'disk-first', 'disk-cache'].includes(databaseMode), '--database-mode must be adaptive, disk-first, or disk-cache')
assert.ok(['memory', 'disk'].includes(acknowledgement), '--acknowledgement must be memory or disk')

const fieldNames = Array.from({ length: fieldCount - 2 }, (_, i) =>
    ['rank', 'reference', 'score', 'sequence'][i] ?? 'field' + String(i).padStart(2, '0'))
const selectedFields = mode === 'focused' ? fieldNames.slice(0, focusedCount) : fieldNames
const output = resolve(process.env.BENCH_OUTPUT_DIR ?? 'test/benchmarks/diagnostics/results')
await mkdir(output, { recursive: true })
const directory = await mkdtemp(join(output, 'locality-data-'))
const resultFile = join(output, 'query-locality-' + mode + '-' + Date.now() + '.json')
const root = { organization_id: 'locality', storage: 'benchmark', database: 'local', array: 'records' }
const db = await createDB({}, { directory, size: branchSize, leafSize, config: { memory }, mode: databaseMode, acknowledgement })
const uuid = rank => rank.toString(16).padStart(32, '0')
const value = (rank, fieldIndex) => rank + fieldIndex * records
const revisions = new Uint32Array(records)
const deleted = new Uint8Array(records)
const result = {
    status: 'running', mode, databaseMode, acknowledgement, records, requests, fieldCount, selectedFields, batchSize, branchSize, leafSize, memoryPercent: memory,
    budgetBytes: db.memoryPolicy.budget, systemMemoryBytes: totalmem(), node: process.version,
    engineRevision: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
    startedAt: new Date().toISOString(), checkpoints: [], gcSegments: [], idleWindows: []
}
const started = performance.now()
const save = () => writeFile(resultFile, JSON.stringify(result, null, 2) + '\n')
const byKey = new Map()
const warmBranches = new Map()
const fieldTrees = new Set()
const offloadedEntrySamples = typeof global.gc === 'function' ? new Map() : null
const metrics = new Map()
const queryCounts = { growth: {}, steady: {} }
result.queryCounts = queryCounts
let phase = 'growth', action = 'background', created = 0, live = 0
let recordSeed = 0x12345678, fieldSeed = 0x87654321
const next = state => (Math.imul(state, 1664525) + 1013904223) >>> 0

function keyStats(key) {
    key ??= '(unassigned)'
    if (!byKey.has(key)) byKey.set(key, { warm: 0, writes: {}, reads: {} })
    return byKey.get(key)
}
function increment(counts, bucket) { counts[bucket] = (counts[bucket] ?? 0) + 1 }
function removeWarm(index) {
    const key = warmBranches.get(index.uuid)
    if (key !== undefined) {
        warmBranches.delete(index.uuid)
        keyStats(key).warm--
    }
}
// Observe real page loads and writes from the engine without requesting either.
const { add, read, evictOne, discard } = db.local
db.local.add = function (index) {
    fieldTrees.add(index.tree)
    return add.call(this, index)
}
db.local.read = function (index) {
    const data = read.call(this, index)
    increment(keyStats(index.tree.key).reads, phase + '.' + action)
    removeWarm(index)
    return data
}
db.local.evictOne = async function (index) {
    const key = index.tree.key
    const sample = offloadedEntrySamples && !offloadedEntrySamples.has(key) && index.entries?.length
        ? new WeakRef(index.entries[0][1][0])
        : undefined
    const written = await evictOne.call(this, index)
    if (written) {
        if (sample && !offloadedEntrySamples.has(key)) offloadedEntrySamples.set(key, sample)
        const stats = keyStats(key)
        increment(stats.writes, phase)
        if (index.onDisk && !warmBranches.has(index.uuid)) {
            warmBranches.set(index.uuid, key)
            stats.warm++
        }
    }
    return written
}
db.local.discard = function (index) {
    const discarded = discard.call(this, index)
    removeWarm(index)
    return discarded
}

function* leaves(index) {
    if (!index.branches) yield index
    else for (const child of index.branches) yield* leaves(child)
}

function indexResidency() {
    const fields = {}
    for (const tree of fieldTrees) {
        const totals = fields[tree.key] ??= { leaves: 0, warm: 0, zeroViewLeaves: 0, entries: 0, warmEntries: 0 }
        for (const leaf of leaves(tree.root)) {
            if (!leaf.length) continue
            totals.leaves++
            totals.entries += leaf.length
            if (!leaf.viewed) totals.zeroViewLeaves++
            if (leaf.onDisk) {
                totals.warm++
                totals.warmEntries += leaf.length
            }
        }
    }
    return fields
}
function indexDetails() {
    return databaseMode === 'disk-first'
        ? { note: 'Per-field tree traversal omitted because it hydrates index branches', residentIndexBranches: db.local.weights.size }
        : indexResidency()
}

function snapshot() {
    const rss = process.memoryUsage()
    return { phase, created, live, elapsedMs: performance.now() - started,
        rssMiB: rss.rss / 2 ** 20, heapMiB: rss.heapUsed / 2 ** 20,
        peakRssMiB: process.resourceUsage().maxRSS / 1024,
        databaseMode, hotLeaves: db.leafTier.size, totalLeaves: db.leafTier.totalSize,
        hotIndexBranches: db.local.weights.size,
        warmLeaves: db.leafTier.warm.size, warmBranches: warmBranches.size,
        leafReads: db.leafTier.reads, leafWrites: db.leafTier.writes,
        indexReads: db.local.reads, indexWrites: db.local.writes, stage: db.memoryPolicy.stage,
        pendingIndex: db.pendingIndexCount }
}
async function idleWindow(durationMs, label) {
    await db.flushDisk()
    const started = performance.now()
    const samples = []
    let nextSample = 0
    while (performance.now() - started < durationMs) {
        await new Promise(resolve => setTimeout(resolve, Math.min(5000, durationMs - (performance.now() - started))))
        if (performance.now() - started >= nextSample) {
            const state = { elapsedMs: performance.now() - started, ...snapshot() }
            samples.push(state)
            console.log('IDLE_SAMPLE', JSON.stringify({ label, ...state }))
            nextSample += 5000
        }
    }
    await db.flushDisk()
    const beforeGc = snapshot()
    if (typeof global.gc === 'function') {
        for (let i = 0; i < 3; i++) {
            await new Promise(setImmediate)
            global.gc()
        }
    }
    const afterGc = snapshot()
    const segment = { label, durationMs, samples, beforeGc, afterGc,
        disk: await statfs(directory), indexResidency: indexResidency(),
        retainedIndexSamples: offloadedEntrySamples
            ? [...offloadedEntrySamples].filter(([, entry]) => entry.deref() !== undefined).map(([key]) => key)
            : undefined }
    result.idleWindows.push(segment)
    console.log('IDLE_DONE', JSON.stringify({ label, beforeGc, afterGc,
        retainedIndexSamples: segment.retainedIndexSamples, warmLeaves: afterGc.warmLeaves,
        warmBranches: afterGc.warmBranches }))
    await save()
}

async function checkpoint() {
    await db.flushDisk()
    const disk = await statfs(directory)
    const state = { ...snapshot(), diskFreeMiB: disk.bavail * disk.bsize / 2 ** 20 }
    result.checkpoints.push(state)
    console.log('PROGRESS', JSON.stringify(state))
    await save()
    assert.ok(state.diskFreeMiB > 600, 'benchmark storage reserve reached')
    assert.ok(state.rssMiB < rssLimitMiB, 'benchmark RSS guard reached')
}
function requestLatencies(label, time) {
    const key = phase + '.' + label
    if (!metrics.has(key)) metrics.set(key, [])
    metrics.get(key).push(time)
}

async function send(method, input, label = method) {
    const begin = performance.now()
    action = label
    const pending = db.send({ ...root, method: 'object.' + method, ...input })
    // CRUD handles the synchronous tree scan before yielding. Deferred work
    // that runs later is counted separately as background.
    action = 'background'
    const response = await pending
    requestLatencies(label, performance.now() - begin)
    assert.equal(response.success, true, JSON.stringify(response.error))
    return response.object
}
function fixture(rank) {
    const document = { uuid: uuid(rank), revision: 0, payload: 'x'.repeat(128 + (rank % 4) * 128) }
    for (let i = 0; i < fieldNames.length; i++) document[fieldNames[i]] = value(rank, i)
    return document
}
function selectRank(limit = records) {
    let rank
    do {
        recordSeed = next(recordSeed)
        rank = recordSeed % limit
    } while (deleted[rank])
    return rank
}

function selectField() {
    fieldSeed = next(fieldSeed)
    const position = fieldSeed % selectedFields.length
    increment(queryCounts[phase], selectedFields[position])
    return position
}

try {
    await save()
    for (let offset = 0; offset < records; offset += batchSize) {
        const length = Math.min(batchSize, records - offset)
        const batch = Array.from({length}, (_, i) => fixture(offset + i))
        const rows = await send('create', { object: batch })
        assert.equal(rows.length, length)
        assert.equal(rows[0].uuid, uuid(offset))
        created += length
        live += length
        await new Promise(setImmediate)
        const rank = selectRank(created)
        const fieldIndex = selectField()
        const query = { [selectedFields[fieldIndex]]: value(rank, fieldIndex) }
        const [match] = await send('read', { filter: { query, limit: 1 } }, 'equality')
        assert.equal(match?.uuid, uuid(rank))
        if (gcEvery && Math.floor(created / gcEvery) > Math.floor((created - length) / gcEvery)) {
            await idleWindow(idleMs, 'records-' + created)
            await db.flushDisk()
            const beforeGc = snapshot()
            if (typeof global.gc === 'function') {
                for (let i = 0; i < 3; i++) {
                    await new Promise(setImmediate)
                    global.gc()
                }
            }
            const afterGc = snapshot()
            const segment = { created, forced: typeof global.gc === 'function', beforeGc, afterGc,
                sampledEntries: offloadedEntrySamples?.size ?? 0,
                sampledEntriesByField: offloadedEntrySamples ? Object.fromEntries([...offloadedEntrySamples.keys()].sort().map(key => [key, 1])) : {},
                retainedSamples: offloadedEntrySamples
                    ? [...offloadedEntrySamples].filter(([, entry]) => entry.deref() !== undefined).map(([key]) => key)
                    : undefined }
            result.gcSegments.push(segment)
            console.log('GC_SEGMENT', JSON.stringify(segment))
            await save()
        }
        if (Math.floor(created / 10_000) !== Math.floor(offset / 10_000) || created === records) await checkpoint()
    }
    const indexDrainStart = performance.now()
    await db.flushIndex()
    await db.flushDisk()
    result.indexDrainMs = performance.now() - indexDrainStart
    result.growth = snapshot()
    result.growthFields = indexDetails()
    assert.equal(db.leafTier.totalSize - 4, records)

    phase = 'steady'
    const steadyStart = performance.now()
    for (let i = 0; i < requests; i++) {
        const rank = selectRank(), id = uuid(rank)
        const step = i % 20
        if (step < 13) {
            const position = selectField()
            const field = selectedFields[position]
            const lower = value(rank, position)
            if (step < 10) {
                const rows = await send('read', { filter: { query: { [field]: lower }, limit: 1 } }, 'equality')
                assert.equal(rows[0]?.uuid, id)
            } else {
                const expected = []
                for (let j = rank; j < Math.min(records, rank + 5); j++)
                    if (!deleted[j]) expected.push(j)
                const query = { [field]: { $gte: lower, $lt: lower + 5 } }
                const rows = await send('read', { filter: { query, limit: expected.length } }, 'range')
                assert.deepEqual(rows.map(row => row.rank).sort((a,b) => a-b), expected)
            }
        } else if (step < 18) {
            const [row] = await send('read', { object: { uuid: id } }, 'uuidRead')
            assert.equal(row?.uuid, id)
            assert.equal(row.revision, revisions[rank])
        } else if (step === 18) {
            const revision = ++revisions[rank]
            const [row] = await send('update', { object: { uuid: id, revision } })
            assert.equal(row?.revision, revision)
        } else {
            const [row] = await send('delete', { object: { uuid: id } })
            assert.equal(row?.uuid, id)
            assert.equal(await db.leafTier.has(id), false)
            deleted[rank] = 1
            live--
        }
        if ((i + 1) % 8 === 0) await new Promise(setImmediate)
        if ((i + 1) % 2000 === 0) await checkpoint()
    }
    result.steadyMs = performance.now() - steadyStart
    result.steady = snapshot()
    assert.equal(db.leafTier.totalSize - 4, live)
    phase = 'drain'
    const drainStart = performance.now()
    await db.flushIndex()
    await db.flushDisk()
    result.finalDrainMs = performance.now() - drainStart
    result.beforeProbeFields = indexDetails()
    const keysToProbe = fieldNames.filter(key => !selectedFields.includes(key))
    if (databaseMode === 'disk-first' && keysToProbe.length) {
        const key = keysToProbe[0], fieldIndex = fieldNames.indexOf(key), reads = db.local.reads
        phase = 'probe'
        const [row] = await send('read', { filter: { query: { [key]: value(0, fieldIndex) }, limit: 1 } }, 'warmField')
        assert.equal(row?.uuid, uuid(0))
        assert.ok(db.local.reads > reads, 'point query should reload warm index data')
        await db.flushDisk()
        result.warmFieldProbe = { key, indexReads: db.local.reads - reads }
    }
    for (const tree of fieldTrees) {
        if (databaseMode === 'disk-first') break
        if (!keysToProbe.includes(tree.key)) continue
        const leaf = Array.from(leaves(tree.root)).find(index => index.onDisk && index.length)
        if (!leaf) continue
        phase = 'probe'
        const reads = db.local.reads
        const [object] = await send('read', { filter: { query: { [tree.key]: leaf.firstValue }, limit: 1 } }, 'warmField')
        assert.equal(object?.uuid, leaf.firstUuid)
        assert.equal(leaf.onDisk, false)
        result.warmFieldProbe = { key: tree.key, indexReads: db.local.reads - reads }
        await db.flushDisk()
        break
    }
    await idleWindow(finalIdleMs, 'final')
    result.status = 'passed'
} catch (error) {
    result.status = 'failed'
    result.error = error.stack
    console.error(error)
    process.exitCode = 1
    try { await db.flushDisk() } catch {}
} finally {
    result.final = snapshot()
    if (offloadedEntrySamples) {
        for (let i = 0; i < 3; i++) {
            await new Promise(setImmediate)
            global.gc()
        }
        const { heapUsed, rss } = process.memoryUsage()
        const stillReachable = [...offloadedEntrySamples].filter(([, entry]) => entry.deref() !== undefined)
            .map(([key]) => key)
        result.afterGc = {
            heapMiB: heapUsed / 2 ** 20, rssMiB: rss / 2 ** 20,
            sampledEntries: offloadedEntrySamples.size, stillReachable
        }
    }
    result.finishedAt = new Date().toISOString()
    result.policySamples = db.memoryPolicy.samples.slice()
    result.leafPolicySamples = db.memoryPolicy.leafSamples.slice()
    result.byKey = Object.fromEntries([...byKey].sort(([a], [b]) => a.localeCompare(b)))
    result.operations = Object.fromEntries([...metrics].map(([label, times]) => {
        times.sort((a,b) => a-b)
        return [label, { count: times.length, p50Ms: times[Math.ceil(times.length * .50) - 1],
            p95Ms: times[Math.ceil(times.length * .95) - 1] }]
    }))
    await save()
    console.log('RESULT', resultFile, result.status)
    await rm(directory, { recursive: true, force: true })
}
