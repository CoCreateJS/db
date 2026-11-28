import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import Disk from '@cocreate/disk'
import { createRuntime } from '../../../src/runtime.js'
import { createBenchmarkRecord, benchmarkUuid, benchmarkFixtureHash, lifecycleRoot } from '../../fixtures/lifecycle.mjs'
import { waitForIndex, waitForIdle } from '../shared/wait-for-index.mjs'

const script = fileURLToPath(import.meta.url)
const records = Number(process.env.BENCH_RECORDS ?? 10000)
const mutations = Number(process.env.BENCH_MUTATIONS ?? 1000)
const row = () => ({ calls: 0, bytes: 0, completed: 0, superseded: 0, cancelled: 0 })
const copy = value => structuredClone(value)
function delta(after, before) {
    const result = {}
    for (const [key, current] of Object.entries(after)) {
        result[key] = {}
        for (const [metric, value] of Object.entries(current)) result[key][metric] = value - (before[key]?.[metric] ?? 0)
    }
    return result
}
function device() {
    const name = process.env.BENCH_BLOCK_DEVICE ?? 'nvme0n1'
    const line = readFileSync('/proc/diskstats', 'utf8').split('\n').map(line => line.trim().split(/\s+/)).find(parts => parts[2] === name)
    if (!line) return undefined
    return { name, reads: Number(line[3]), writes: Number(line[7]), bytesRead: Number(line[5]) * 512,
        bytesWritten: Number(line[9]) * 512, writeTimeMs: Number(line[10]), busyTimeMs: Number(line[12]) }
}
function deviceDelta(after, before, elapsedMs) {
    if (!after || !before) return undefined
    const writes = after.writes - before.writes, reads = after.reads - before.reads
    return { name: after.name, writes, reads, bytesWritten: after.bytesWritten - before.bytesWritten,
        bytesRead: after.bytesRead - before.bytesRead, operationsPerSecond: (writes + reads) / elapsedMs * 1000,
        writeMiBPerSecond: (after.bytesWritten - before.bytesWritten) / 1048576 / elapsedMs * 1000,
        averageWriteMs: writes ? (after.writeTimeMs - before.writeTimeMs) / writes : 0,
        busyPercent: (after.busyTimeMs - before.busyTimeMs) / elapsedMs * 100 }
}

async function child() {
    const directory = await fs.mkdtemp(join(tmpdir(), 'cocreate-disk-coalescing-'))
    const concurrency = Number(process.env.BENCH_DISK_CONCURRENCY ?? 16)
    const adapter = await Disk.init({ directory, concurrency })
    const submitted = {}, physical = {}, native = {}
    const kind = path => path.includes('/leaves/') ? 'leaf' : path.includes('/branches/') ? 'branch' : 'config'
    // Instrument the real provider's filesystem boundary, after queue coalescing.
    // Built-in ESM live exports are restored before cleanup/report output.
    for (const method of ['writeFile', 'rename', 'access', 'readFile', 'unlink', 'mkdir']) {
        native[method] = fs[method]
        fs[method] = async (...args) => {
            const path = String(args[0])
            const tracked = path.startsWith(directory + '/')
            const metric = tracked ? physical[`${kind(path)}.${method}`] ??= row() : undefined
            if (metric) { metric.calls++; if (method === 'writeFile') metric.bytes += Buffer.byteLength(args[1]) }
            const value = await native[method](...args)
            if (metric) metric.completed++
            return value
        }
    }
    syncBuiltinESMExports()
    const disk = { queue: adapter.queue, async execute(request) {
        const metric = submitted[`${request.kind}.${request.operation}`] ??= row()
        metric.calls++
        if (request.operation === 'write') metric.bytes += Buffer.byteLength(request.data)
        const result = await adapter.execute(request)
        if (result?.superseded) metric.superseded++
        else if (result?.cancelled) metric.cancelled++
        else metric.completed++
        return result
    } }
    const db = await createRuntime({}, { disk, size: 64 })
    const scope = lifecycleRoot(records), phases = []
    const send = async request => {
        const result = await db.send({ ...scope, ...request })
        assert.equal(result.success, true, result.error?.join('; '))
        return result
    }
    let primary
    async function phase(name, count, operation) {
        const initialSubmitted = copy(submitted), initialPhysical = copy(physical), initialDevice = device()
        const started = performance.now()
        await operation()
        const acknowledgementMs = performance.now() - started
        await waitForIndex(db, { timeoutMs: 120000 })
        const indexedMs = performance.now() - started
        const requestsPendingAtIndexReady = db.pendingDiskCount
        await waitForIdle(db, { timeoutMs: 120000 })
        const storedMs = performance.now() - started
        phases.push({ name, records: count, acknowledgementMs, indexedMs, storedMs, requestsPendingAtIndexReady,
            submitted: delta(submitted, initialSubmitted), physical: delta(physical, initialPhysical),
            device: deviceDelta(device(), initialDevice, storedMs) })
    }
    try {
        await phase('bulkCreate', records, async () => {
            for (let offset = 0; offset < records; offset += 1000) {
                const object = Array.from({ length: Math.min(1000, records - offset) }, (_, i) => createBenchmarkRecord(offset + i, records, scope.organization_id))
                const response = await send({ method: 'object.create', object })
                primary ??= response.object[0].parent
            }
        })
        const samples = Array.from({ length: mutations }, (_, i) => {
            const record = createBenchmarkRecord(records + i, records + mutations, scope.organization_id)
            record.group = 'crud-sample'
            return record
        })
        await phase('singleCreate', mutations, async () => {
            for (const object of samples) await send({ method: 'object.create', object })
        })
        await phase('singleUpdate', mutations, async () => {
            for (const object of samples) await send({ method: 'object.update', object: { uuid: object.uuid, '$inc.revision': 1 } })
        })
        const updated = await send({ method: 'object.read', filter: { query: { group: 'crud-sample', revision: 1 }, limit: 0 } })
        assert.equal(updated.object.length, mutations)
        await phase('singleDelete', mutations, async () => {
            for (const object of samples) await send({ method: 'object.delete', object: { uuid: object.uuid } })
        })
        const organization = await db.organizations.get(scope.organization_id)
        assert.deepEqual(await organization.harvest({ uuid: primary }), { count: 1 })
        const restored = await send({ method: 'object.read', filter: { query: { group: 'group-3' }, limit: 0 } })
        assert.equal(restored.object.length, Math.floor((records + 6) / 10))
        assert.equal((await send({ method: 'object.read', object: { uuid: benchmarkUuid(records) } })).object.length, 0)
        const loaded = await send({ method: 'object.read', filter: { query: { rank: { $gte: 0 } }, limit: 0 } })
        assert.equal(loaded.object.length, records)
        await db.close()
        const output = { status: 'passed', records, mutations, fixtureHash: benchmarkFixtureHash(records), concurrency,
            threadpoolSize: Number(process.env.UV_THREADPOOL_SIZE ?? 4), node: process.version, phases,
            physicalCountersVerified: Object.keys(physical).some(key => key.endsWith('.writeFile')),
            correctness: { indexedUpdates: true, coldIndexes: true, deletedFiles: true, finalRecords: loaded.object.length } }
        process.stdout.write(JSON.stringify(output) + '\n')
    } finally {
        await db.close().catch(() => {})
        for (const [method, original] of Object.entries(native)) fs[method] = original
        syncBuiltinESMExports()
        await fs.rm(directory, { recursive: true, force: true })
    }
}

if (process.env.BENCH_DISK_CHILD === '1') await child()
else {
    const directory = resolve(process.env.BENCH_OUTPUT_DIR ?? join(dirname(script), '../providers/cocreatedb/results', `disk-coalescing-${new Date().toISOString().replaceAll(':', '-')}`))
    await fs.mkdir(directory, { recursive: true })
    const execute = promisify(execFile), cases = [[16, 4], [32, 4], [16, 8], [32, 8], [16, 4], [8, 4], [8, 4]]
    const results = []
    for (const [index, [concurrency, pool]] of cases.entries()) {
        console.log(`case=${index + 1} concurrency=${concurrency} threadpool=${pool}`)
        const { stdout } = await execute(process.execPath, [script], { timeout: 180000, maxBuffer: 4 * 1024 * 1024,
            env: { ...process.env, BENCH_DISK_CHILD: '1', BENCH_DISK_CONCURRENCY: String(concurrency), UV_THREADPOOL_SIZE: String(pool) } })
        const result = JSON.parse(stdout)
        assert.equal(result.physicalCountersVerified, true)
        results.push(result)
        await fs.writeFile(join(directory, `case-${index + 1}.json`), JSON.stringify(result, null, 2) + '\n')
        console.log(JSON.stringify({ concurrency, pool, storedMs: result.phases.reduce((sum, phase) => sum + phase.storedMs, 0),
            branchRequests: result.phases.reduce((sum, phase) => sum + (phase.submitted['branch.write']?.calls ?? 0), 0),
            branchFiles: result.phases.reduce((sum, phase) => sum + (phase.physical['branch.writeFile']?.completed ?? 0), 0) }))
    }
    await fs.writeFile(join(directory, 'summary.json'), JSON.stringify({ records, mutations, results }, null, 2) + '\n')
    console.log(`output=${directory}`)
}
