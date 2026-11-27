import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import Disk from '@cocreate/disk'
import { createBenchmarkRecord, lifecycleRoot, benchmarkFixtureHash } from '../../fixtures/lifecycle.mjs'
import { waitForIdle } from '../shared/wait-for-index.mjs'

const source = resolve(process.argv[2] ?? '.')
const load = path => import(pathToFileURL(join(source, path)))
const { createRuntime } = await load('src/runtime.js')
const directory = await mkdtemp(join(tmpdir(), 'cocreate-primary-profile-'))
const adapter = await Disk.init({ directory })
const io = {}
const disk = { async execute(request) {
    const kind = request.path?.includes('leaves/') ? 'leaf' : request.path?.includes('branches/') ? 'branch' : 'config'
    const key = `${kind}.${request.operation}`
    const start = performance.now()
    try { return await adapter.execute(request) }
    finally { const row = io[key] ??= { calls: 0, elapsedMs: 0 }; row.calls++; row.elapsedMs += performance.now() - start }
} }
const db = await createRuntime({}, { disk, size: 64 })
const envelope = lifecycleRoot(10000)
const cpu = process.cpuUsage()
const start = performance.now()
let acknowledgementMs = 0
try {
    for (let offset = 0; offset < 10000; offset += 1000) {
        const object = Array.from({ length: 1000 }, (_, i) => createBenchmarkRecord(offset + i, 10000, envelope.organization_id))
        const before = performance.now()
        const result = await db.send({ ...envelope, method: 'object.create', object })
        acknowledgementMs += performance.now() - before
        assert.equal(result.success, true, result.error?.join('; '))
    }
    const acknowledgedAtMs = performance.now() - start
    let found
    do {
        found = await db.send({ ...envelope, method: 'object.read', filter: { query: { rank: 9999 }, limit: 1 } })
        if (performance.now() - start > 120000) throw Error('Index did not become searchable')
        if (!found.object.length) await new Promise(resolve => setTimeout(resolve, 1))
    } while (!found.object.length)
    assert.equal(found.object[0].rank, 9999)
    const searchableMs = performance.now() - start
    const pendingDiskAtSearchable = db.pendingDiskCount ?? null
    await waitForIdle(db, { timeoutMs: 120000 })
    const storageCompleteMs = performance.now() - start
    const all = await db.send({ ...envelope, method: 'object.read', filter: { query: { rank: { $gte: 0 } }, limit: 0 } })
    assert.equal(all.object.length, 10000)
    const result = { source, node: process.version, records: 10000, fixtureHash: benchmarkFixtureHash(10000), acknowledgementMs, acknowledgedAtMs,
        searchableMs, pendingDiskAtSearchable, storageCompleteMs, peakRssBytes: process.resourceUsage().maxRSS * 1024,
        cpu: process.cpuUsage(cpu), io }
    console.log(JSON.stringify(result, null, 2))
    if (process.argv[3]) await writeFile(process.argv[3], JSON.stringify(result, null, 2) + '\n')
} finally { await db.close(); await rm(directory, { recursive: true, force: true }) }
