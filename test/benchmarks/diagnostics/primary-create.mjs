import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import Disk from '@cocreate/disk'
import { createBenchmarkRecord, lifecycleRoot } from '../../fixtures/lifecycle.mjs'
import { waitForIndex } from '../shared/wait-for-index.mjs'

const source = resolve(process.argv[2] ?? '.')
const load = path => import(pathToFileURL(join(source, path)))
const { createRuntime } = await load('src/runtime.js')
const { LeafTier } = await load('src/tree/leaves.js')
const { LocalTier } = await load('src/tree/local-core.js')
const { Tree: IndexTree } = await load('src/tree/btree.js')
const stages = {}
for (const [prototype, name] of [[LeafTier.prototype, 'persistDirty'], [LocalTier.prototype, 'persistDirty'], [IndexTree.prototype, 'insertMany']]) {
    const label = `${prototype.constructor.name}.${name}`
    const original = prototype[name]
    stages[label] = { calls: 0, elapsedMs: 0 }
    prototype[name] = async function(...args) {
        const start = performance.now()
        try { return await original.apply(this, args) }
        finally { stages[label].calls++; stages[label].elapsedMs += performance.now() - start }
    }
}
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
    const drain = performance.now()
    await waitForIndex(db)
    const result = { source, records: 10000, acknowledgementMs, drainMs: performance.now() - drain, totalMs: performance.now() - start, cpu: process.cpuUsage(cpu), stages, io }
    console.log(JSON.stringify(result, null, 2))
    if (process.argv[3]) await writeFile(process.argv[3], JSON.stringify(result, null, 2) + '\n')
} finally { await db.close(); await rm(directory, { recursive: true, force: true }) }
