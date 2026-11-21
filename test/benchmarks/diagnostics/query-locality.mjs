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
    fields: { type: 'string', default: '42' },
    'focused-fields': { type: 'string', default: '4' },
    memory: { type: 'string', default: '25' }
} })
const { mode } = values
const records = Number(values.records), requests = Number(values.requests)
const fieldCount = Number(values.fields), focusedCount = Number(values['focused-fields'])
const memory = Number(values.memory), batchSize = Number(values['batch-size'])
const branchSize = 1024, leafSize = Number(values['leaf-size'])
assert.ok(['focused', 'scattered'].includes(mode), '--mode must be focused or scattered')
assert.ok(Number.isSafeInteger(records) && records >= 100, '--records must be at least 100')
assert.ok(Number.isSafeInteger(requests) && requests >= 20, '--requests must be at least 20')
assert.ok(Number.isSafeInteger(fieldCount) && fieldCount > 3, '--fields must be at least 4')
assert.ok(Number.isSafeInteger(focusedCount) && focusedCount >= 1 && focusedCount <= 4 && focusedCount <= fieldCount - 2,
    '--focused-fields must be 1–4 and leave room for revision and payload')
assert.ok(Number.isSafeInteger(batchSize) && batchSize > 0, '--batch-size must be positive')
assert.ok(Number.isSafeInteger(leafSize) && leafSize >= 2, '--leaf-size must be at least 2')
assert.ok(memory > 0 && memory <= 100, '--memory must be between 0 and 100')

const fieldNames = Array.from({ length: fieldCount - 2 }, (_, i) =>
    ['rank', 'reference', 'score', 'sequence'][i] ?? 'field' + String(i).padStart(2, '0'))
const selectedFields = mode === 'focused' ? fieldNames.slice(0, focusedCount) : fieldNames
const output = resolve(process.env.BENCH_OUTPUT_DIR ?? 'test/benchmarks/diagnostics/results')
await mkdir(output, { recursive: true })
const directory = await mkdtemp(join(output, 'locality-data-'))
const resultFile = join(output, 'query-locality-' + mode + '-' + Date.now() + '.json')
const scope = { organization_id: 'locality', storage: 'benchmark', database: 'local', array: 'records' }
const db = createDB({}, { directory, size: branchSize, leafSize, config: { memory } })
const uuid = rank => rank.toString(16).padStart(32, '0')
const value = (rank, fieldIndex) => rank + fieldIndex * records
const revisions = new Uint32Array(records)
const deleted = new Uint8Array(records)
const result = {
    status: 'running', mode, records, requests, fieldCount, selectedFields, batchSize, branchSize, leafSize, memoryPercent: memory,
    budgetBytes: db.memoryPolicy.budget, systemMemoryBytes: totalmem(), node: process.version,
    engineRevision: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
    startedAt: new Date().toISOString(), checkpoints: []
}
const started = performance.now()
const save = () => writeFile(resultFile, JSON.stringify(result, null, 2) + '\n')
const byKey = new Map()
const coldPartitions = new Map()
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
    if (!byKey.has(key)) byKey.set(key, { cold: 0, writes: {}, reads: {} })
    return byKey.get(key)
}
function increment(counts, bucket) { counts[bucket] = (counts[bucket] ?? 0) + 1 }
function removeCold(partition) {
    const key = coldPartitions.get(partition.uuid)
    if (key !== undefined) {
        coldPartitions.delete(partition.uuid)
        keyStats(key).cold--
    }
}
// Observe real page loads and writes from the engine without requesting either.
const { add, read, evictOne, discard } = db.local
db.local.add = function (partition) {
    fieldTrees.add(partition.tree)
    return add.call(this, partition)
}
db.local.read = function (partition) {
    const data = read.call(this, partition)
    increment(keyStats(partition.tree.key).reads, phase + '.' + action)
    removeCold(partition)
    return data
}
db.local.evictOne = async function (partition) {
    const key = partition.tree.key
    const sample = offloadedEntrySamples && !offloadedEntrySamples.has(key) && partition.entries?.length
        ? new WeakRef(partition.entries[0][1][0])
        : undefined
    const written = await evictOne.call(this, partition)
    if (written) {
        if (sample && !offloadedEntrySamples.has(key)) offloadedEntrySamples.set(key, sample)
        const stats = keyStats(key)
        increment(stats.writes, phase)
        if (partition.onDisk && !coldPartitions.has(partition.uuid)) {
            coldPartitions.set(partition.uuid, key)
            stats.cold++
        }
    }
    return written
}
db.local.discard = function (partition) {
    const discarded = discard.call(this, partition)
    removeCold(partition)
    return discarded
}

function* leaves(partition) {
    if (!partition.indexes) yield partition
    else for (const child of partition.indexes) yield* leaves(child)
}

function indexResidency() {
    const fields = {}
    for (const tree of fieldTrees) {
        const totals = fields[tree.key] ??= { leaves: 0, cold: 0, zeroViewLeaves: 0, entries: 0, coldEntries: 0 }
        for (const leaf of leaves(tree.root)) {
            if (!leaf.length) continue
            totals.leaves++
            totals.entries += leaf.length
            if (!leaf.viewed) totals.zeroViewLeaves++
            if (leaf.onDisk) {
                totals.cold++
                totals.coldEntries += leaf.length
            }
        }
    }
    return fields
}

function snapshot() {
    const rss = process.memoryUsage()
    return { phase, created, live, elapsedMs: performance.now() - started,
        rssMiB: rss.rss / 2 ** 20, heapMiB: rss.heapUsed / 2 ** 20,
        peakRssMiB: process.resourceUsage().maxRSS / 1024,
        coldArtifacts: db.artifactTier.cold.size, coldPartitions: coldPartitions.size,
        artifactReads: db.artifactTier.reads, artifactWrites: db.artifactTier.writes,
        indexReads: db.local.reads, indexWrites: db.local.writes, stage: db.memoryPolicy.stage,
        pendingIndex: db.pendingIndexCount }
}
async function checkpoint() {
    const disk = await statfs(directory)
    const state = { ...snapshot(), diskFreeMiB: disk.bavail * disk.bsize / 2 ** 20 }
    result.checkpoints.push(state)
    console.log('PROGRESS', JSON.stringify(state))
    await save()
    assert.ok(state.diskFreeMiB > 600, 'benchmark storage reserve reached')
    assert.ok(state.rssMiB < 4600, 'benchmark RSS guard reached')
}
function requestLatencies(label, time) {
    const key = phase + '.' + label
    if (!metrics.has(key)) metrics.set(key, [])
    metrics.get(key).push(time)
}

async function send(method, input, label = method) {
    const begin = performance.now()
    action = label
    const pending = db.send({ ...scope, method: 'object.' + method, ...input })
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
        if (Math.floor(created / 10_000) !== Math.floor(offset / 10_000) || created === records) await checkpoint()
    }
    const indexDrainStart = performance.now()
    db.flushIndex()
    result.indexDrainMs = performance.now() - indexDrainStart
    result.growth = snapshot()
    result.growthFields = indexResidency()
    assert.equal(db.artifactTier.totalSize - 4, records)

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
            assert.equal(db.artifactTier.has(id), false)
            deleted[rank] = 1
            live--
        }
        if ((i + 1) % 8 === 0) await new Promise(setImmediate)
        if ((i + 1) % 2000 === 0) await checkpoint()
    }
    result.steadyMs = performance.now() - steadyStart
    result.steady = snapshot()
    assert.equal(db.artifactTier.totalSize - 4, live)
    phase = 'drain'
    const drainStart = performance.now()
    db.flushIndex()
    await db.memoryPolicy.flush()
    result.finalDrainMs = performance.now() - drainStart
    result.beforeProbeFields = indexResidency()
    const keysToProbe = fieldNames.filter(key => !selectedFields.includes(key))
    for (const tree of fieldTrees) {
        if (!keysToProbe.includes(tree.key)) continue
        const leaf = Array.from(leaves(tree.root)).find(partition => partition.onDisk && partition.length)
        if (!leaf) continue
        phase = 'probe'
        const reads = db.local.reads
        const [object] = await send('read', { filter: { query: { [tree.key]: leaf.firstValue }, limit: 1 } }, 'coldField')
        assert.equal(object?.uuid, leaf.firstUuid)
        assert.equal(leaf.onDisk, false)
        result.coldFieldProbe = { key: tree.key, indexReads: db.local.reads - reads }
        await db.memoryPolicy.flush()
        break
    }
    result.status = 'passed'
} catch (error) {
    result.status = 'failed'
    result.error = error.stack
    console.error(error)
    process.exitCode = 1
    try { await db.memoryPolicy.flush() } catch {}
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
    result.artifactPolicySamples = db.memoryPolicy.artifactSamples.slice()
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
