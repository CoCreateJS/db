import { testOrganization } from '../test-support/tree.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import DB from '@cocreate/db'
import { databaseRuntimes } from '../src/runtime.js'
import { treeContexts } from '../src/tree/internal.js'
import { MemoryDisk } from '../test-support/memory-disk.mjs'
import { waitForCondition, waitForIdle } from './benchmarks/shared/wait-for-index.mjs'

function host() {
    const server = new EventEmitter()
    server.isPrimary = true
    server.id = 'node-memory-test'
    let timestamp = 0
    return { server, sample(max) { server.emit('telemetry', { data: { serverId: server.id, workerId: 1, timestamp: ++timestamp, memory: { max } } }) } }
}
const envelope = { storage: 'test', database: 'app', array: 'items' }
const create = (tree, array = 'items', count = 1) => tree.execute({ ...envelope, array, method: 'object.create', object: Array.from({ length: count }, (_, score) => ({ score })) })

test('node pressure starts at 75%, removes the locally lowest-weight table, and stops at 50%', async () => {
    const { server, sample } = host()
    const db = await DB.init(server, { prompt: false, disk: new MemoryDisk() })
    const runtime = databaseRuntimes.get(db)
    try {
        const hot = await testOrganization(db, 'hot'), cold = await testOrganization(db, 'cold')
        const hotLeaf = (await create(hot)).object[0], coldLeaf = (await create(cold)).object[0]
        await Promise.all([hot, cold].map(tree => waitForIdle(tree)))
        const hotTree = await hot.getTree(hotLeaf.parent)
        for (let i = 0; i < 20; i++) await hotTree.leaves.get(hotLeaf.uuid)
        // Rank data tables, keeping structural tables hot for this assertion.
        for (const org of [hot, cold]) for (const table of org.trees.values()) if (table.uuid !== hotLeaf.parent && table.uuid !== coldLeaf.parent) table.weight = 100
        const removals = []
        const prune = runtime.trees.prune.bind(runtime.trees)
        runtime.trees.prune = options => {
            const before = runtime.trees.status().trees
            const result = prune(options)
            const remaining = new Set(runtime.trees.status().trees.map(tree => tree.uuid))
            for (const tree of before) if (!remaining.has(tree.uuid)) removals.push({ organization: tree.organization_id, uuid: tree.uuid })
            if (result.count) sample(50)
            return result
        }
        sample(74.9)
        assert.equal(runtime.memory.pruning, false)
        sample(75)
        await waitForCondition(() => runtime.memory.pruneCycles === 1)
        assert.deepEqual(removals, [{ organization: 'cold', uuid: coldLeaf.parent }])
        assert.equal(runtime.memory.pruning, false)
        sample(74)
        assert.equal(runtime.memory.pruning, false, 'recovery requires a fresh 75% crossing')
        assert.equal(await (await hot.getTree(hotLeaf.parent)).leaves.get(hotLeaf.uuid), hotLeaf)
        assert.deepEqual(db.config.memory, { pruneAt: 75, retainAt: 50 })
        assert.equal(hotTree.config.diskFirst, false)
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
        const tree = await testOrganization(db, 'a')
        const leaf = (await create(tree, 'items', 1030)).object[0]
        await started
        sample(75)
        assert.equal(tree.pruneCandidates.some(candidate => candidate.uuid === leaf.parent), false)
        for (const table of tree.trees.values()) if (table.uuid !== leaf.parent) table.active++
        assert.deepEqual(await tree.prune({ uuid: leaf.parent }), { count: 0 })
        sample(60)
        assert.equal(runtime.memory.pruning, true)
        const updated = await tree.execute({ ...envelope, method: 'object.update', object: { uuid: leaf.uuid, score: 2000 } })
        assert.equal(updated.success, true)
        assert.deepEqual(await tree.prune({ uuid: leaf.parent }), { count: 0 }, 'an update arriving during storage remains protected')
        const prune = runtime.trees.prune.bind(runtime.trees)
        const pruned = []
        runtime.trees.prune = options => {
            const before = runtime.trees.status().trees
            const result = prune(options)
            if (result.count) {
                const remaining = new Set(runtime.trees.status().trees.map(table => table.uuid))
                for (const table of before) if (!remaining.has(table.uuid)) {
                    assert.equal(table.pendingIndexCount, 0, 'indexing is complete')
                    assert.equal(table.pendingDiskCount, 0, 'storage is complete')
                    pruned.push(table.uuid)
                }
                sample(50)
            }
            return result
        }
        release()
        await waitForCondition(() => runtime.memory.branchesPruned === 1)
        assert.deepEqual(pruned, [leaf.parent])
        assert.equal(runtime.memory.pruning, false)
        assert.equal((await (await tree.getTree(leaf.parent)).leaves.get(leaf.uuid)).score, 2000)
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
        const tree = await testOrganization(db, 'a')
        const leaf = (await create(tree)).object[0]
        await started
        sample(80)
        sample(50)
        release()
        await waitForIdle(tree)
        assert.equal(await (await tree.getTree(leaf.parent)).leaves.get(leaf.uuid), leaf)
        assert.equal(runtime.memory.branchesPruned, 0)
    } finally { release(); await runtime.close() }
})

test('memory-only trees retain their only copy under pressure and pressure never enables disk-first', async () => {
    const { server, sample } = host()
    const db = await DB.init(server, { prompt: false })
    const runtime = databaseRuntimes.get(db)
    try {
        const tree = await testOrganization(db, 'a')
        const leaf = (await create(tree)).object[0]
        await waitForIdle(tree)
        sample(95)
        await new Promise(resolve => setTimeout(resolve, 5))
        assert.equal(runtime.memory.pruning, true)
        assert.equal(runtime.memory.branchesPruned, 0)
        assert.equal((await tree.getTree(leaf.parent)).config.diskFirst, false)
        assert.equal(await (await tree.getTree(leaf.parent)).leaves.get(leaf.uuid), leaf)
        assert.equal(runtime.memory.pruneError, undefined)
    } finally { await runtime.close() }
})
