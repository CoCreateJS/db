import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import DB from '@cocreate/db'
import { databaseRuntimes } from '../src/runtime.js'
import { treeContexts } from '../src/tree/internal.js'
import { MemoryDisk } from '../test-support/memory-disk.mjs'
import { waitForCondition, waitForIndex } from './benchmarks/shared/wait-for-index.mjs'

function host() {
    const server = new EventEmitter()
    server.isPrimary = true
    server.id = 'node-memory-test'
    let timestamp = 0
    return { server, sample(max) { server.emit('telemetry', { data: { serverId: server.id, workerId: 1, timestamp: ++timestamp, memory: { max } } }) } }
}
const envelope = { storage: 'test', database: 'app', array: 'items' }
const create = (tree, array = 'items', count = 1) => tree.execute({ ...envelope, array, method: 'object.create', object: Array.from({ length: count }, (_, score) => ({ score })) })

test('node pressure starts at 75%, removes the globally lowest-weight table, and stops at 50%', async () => {
    const { server, sample } = host()
    const db = await DB.init(server, { prompt: false, disk: new MemoryDisk() })
    const runtime = databaseRuntimes.get(db)
    try {
        const hot = await db.organizations.get('hot'), cold = await db.organizations.get('cold')
        const hotLeaf = (await create(hot)).object[0], coldLeaf = (await create(cold)).object[0]
        await Promise.all([hot, cold].map(tree => waitForIndex(treeContexts.get(tree))))
        for (let i = 0; i < 20; i++) await hot.leaves.get(hotLeaf.uuid)
        const removals = []
        for (const tree of [hot, cold]) {
            const prune = tree.prune.bind(tree)
            tree.prune = async options => {
                const result = await prune(options)
                removals.push({ organization: tree.organizationId, uuid: options.uuid })
                sample(50)
                return result
            }
        }
        sample(74.9)
        assert.equal(runtime.memory.pruning, false)
        sample(75)
        await waitForCondition(() => runtime.memory.pruneCycles === 1)
        assert.deepEqual(removals, [{ organization: 'cold', uuid: coldLeaf.parent }])
        assert.equal(runtime.memory.pruning, false)
        sample(74)
        assert.equal(runtime.memory.pruning, false, 'recovery requires a fresh 75% crossing')
        assert.equal(await hot.leaves.get(hotLeaf.uuid), hotLeaf)
        assert.deepEqual(db.config.memory, { pruneAt: 75, retainAt: 50 })
        assert.equal(hot.config.diskFirst, false)
    } finally { await runtime.close() }
})

test('a queued group remains protected through storage, then becomes eligible without another telemetry sample', async () => {
    const { server, sample } = host()
    let stored, release
    const started = new Promise(resolve => { stored = resolve })
    const gate = new Promise(resolve => { release = resolve })
    let held = false
    const persistence = { async execute(request) {
        if (!held && request.operation === 'write' && request.kind === 'leaf') {
            held = true
            stored()
            await gate
        }
        return request
    } }
    const db = await DB.init(server, { prompt: false, disk: new MemoryDisk(), persistence })
    const runtime = databaseRuntimes.get(db)
    try {
        const tree = await db.organizations.get('a')
        const leaf = (await create(tree, 'items', 1030)).object[0]
        await started
        sample(75)
        assert.equal(treeContexts.get(tree).pruneCandidates.length, 0)
        assert.deepEqual(await tree.prune({ uuid: leaf.parent }), { count: 0 })
        sample(60)
        assert.equal(runtime.memory.pruning, true)
        const updated = await tree.execute({ ...envelope, method: 'object.update', object: { uuid: leaf.uuid, score: 2000 } })
        assert.equal(updated.success, true)
        assert.deepEqual(await tree.prune({ uuid: leaf.parent }), { count: 0 }, 'an update arriving during storage remains protected')
        const prune = tree.prune.bind(tree)
        const pruned = []
        tree.prune = async options => {
            assert.equal(treeContexts.get(tree).pendingIndexCount, 0, 'a batch is not a completed table')
            const result = await prune(options)
            pruned.push(options.uuid)
            sample(50)
            return result
        }
        release()
        await waitForCondition(() => runtime.memory.branchesPruned === 1)
        assert.deepEqual(pruned, [leaf.parent])
        assert.equal(runtime.memory.pruning, false)
        assert.equal((await tree.leaves.get(leaf.uuid)).score, 2000)
    } finally { release(); await runtime.close() }
})

test('dropping below the low watermark while storage is pending prevents eviction on completion', async () => {
    const { server, sample } = host()
    let release, stored
    const gate = new Promise(resolve => { release = resolve })
    const started = new Promise(resolve => { stored = resolve })
    const persistence = { async execute(request) {
        if (request.kind === 'leaf') { stored(); await gate }
        return request
    } }
    const db = await DB.init(server, { prompt: false, disk: new MemoryDisk(), persistence })
    const runtime = databaseRuntimes.get(db)
    try {
        const tree = await db.organizations.get('a')
        const leaf = (await create(tree)).object[0]
        await started
        sample(80)
        sample(50)
        release()
        await waitForIndex(treeContexts.get(tree))
        assert.equal(await tree.leaves.get(leaf.uuid), leaf)
        assert.equal(runtime.memory.branchesPruned, 0)
    } finally { release(); await runtime.close() }
})

test('memory-only trees retain their only copy under pressure and pressure never enables disk-first', async () => {
    const { server, sample } = host()
    const db = await DB.init(server, { prompt: false })
    const runtime = databaseRuntimes.get(db)
    try {
        const tree = await db.organizations.get('a')
        const leaf = (await create(tree)).object[0]
        await waitForIndex(treeContexts.get(tree))
        sample(95)
        await new Promise(resolve => setTimeout(resolve, 5))
        assert.equal(runtime.memory.pruning, true)
        assert.equal(runtime.memory.branchesPruned, 0)
        assert.equal(tree.config.diskFirst, false)
        assert.equal(await tree.leaves.get(leaf.uuid), leaf)
        assert.equal(runtime.memory.pruneError, undefined)
    } finally { await runtime.close() }
})
