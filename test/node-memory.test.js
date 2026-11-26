import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import DB from '@cocreate/db'
import { databaseRuntimes } from '../src/runtime.js'
import { MemoryDisk } from '../test-support/memory-disk.mjs'
import { waitForCondition } from './benchmarks/shared/wait-for-index.mjs'

function host() {
    const server = new EventEmitter()
    server.isPrimary = true
    server.id = 'node-memory-test'
    let timestamp = 0
    return { server, sample(max) { server.emit('telemetry', { data: { serverId: server.id, workerId: 1, timestamp: ++timestamp, memory: { total: 1000, max } } }) } }
}

test('every managed Tree receives the same pruning policy and a per-Tree branch limit', async () => {
    const { server, sample } = host()
    const db = await DB.init(server, { prompt: false, disk: new MemoryDisk(), prune: { strategy: 'lru', limit: 3 } })
    const runtime = databaseRuntimes.get(db)
    try {
        const trees = await Promise.all(['a', 'b'].map(id => db.organizations.get(id)))
        const calls = []
        for (const tree of trees) tree.prune = async options => {
            calls.push({ id: tree.organizationId, ...options })
            return { count: 3, target: 3, candidates: 3, skipped: 0 }
        }
        sample(25)
        await waitForCondition(() => runtime.memory.pruneCycles === 1)
        assert.deepEqual(calls, [
            { id: 'a', strategy: 'lru', limit: 3 },
            { id: 'b', strategy: 'lru', limit: 3 }
        ])
        assert.equal(runtime.memory.branchesPruned, 6)
        sample(90)
        await waitForCondition(() => runtime.memory.pruneCycles === 4)
        assert.ok(trees.every(tree => tree.config.diskFirst))
        const later = await db.organizations.get('later')
        assert.equal(later.config.diskFirst, true)
        assert.deepEqual(later.config.prune, { strategy: 'lru', limit: 3 })
        assert.deepEqual(db.config.memory, { stages: [25, 50, 75, 90], diskFirst: 90, hysteresis: 2.5 })
        sample(87)
        assert.equal(later.config.diskFirst, false)
        assert.ok(trees.every(tree => !tree.config.diskFirst))
    } finally { await runtime.close() }
})

test('node pressure prunes without enabling disk-first on an in-memory Tree', async () => {
    const { server, sample } = host()
    const db = await DB.init(server, { prompt: false })
    const runtime = databaseRuntimes.get(db)
    try {
        const tree = await db.organizations.get('a')
        sample(95)
        await waitForCondition(() => runtime.memory.pruneCycles === 4)
        assert.equal(tree.config.diskFirst, false)
        assert.equal(runtime.memory.pruneError, undefined)
    } finally { await runtime.close() }
})

test('custom node thresholds rearm after hysteresis and explicit disk-first remains enabled', async () => {
    const { server, sample } = host()
    const db = await DB.init(server, { prompt: false, disk: new MemoryDisk(), memory: { stages: [60, 80], diskFirst: 95, hysteresis: 5 } })
    const runtime = databaseRuntimes.get(db)
    try {
        await db.organizations.get('a')
        sample(59)
        assert.equal(runtime.memory.stage, 0)
        sample(81)
        await waitForCondition(() => runtime.memory.pruneCycles === 2)
        sample(77)
        assert.equal(runtime.memory.stage, 2)
        sample(74)
        assert.equal(runtime.memory.stage, 1)
        sample(80)
        await waitForCondition(() => runtime.memory.pruneCycles === 3)
    } finally { await runtime.close() }
    const explicit = await DB.init(server, { prompt: false, disk: new MemoryDisk(), mode: 'disk-first' })
    try {
        const tree = await explicit.organizations.get('explicit')
        sample(10)
        assert.equal(tree.config.diskFirst, true)
    } finally { await databaseRuntimes.get(explicit).close() }
})
