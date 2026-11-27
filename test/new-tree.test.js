import test from 'node:test'
import assert from 'node:assert/strict'
import { waitForIndex, waitForCondition } from './benchmarks/shared/wait-for-index.mjs'
import { Tree } from '../src/index.js'
import { createConfiguration } from '../src/runtime.js'
import planQuery from '../src/tree/planner.js'
import { createTestTree, inspectTree } from '../test-support/tree.mjs'
import { Tree as IndexTree } from '../src/tree/btree.js'
import { MemoryDisk } from '../test-support/memory-disk.mjs'

const envelope = { organization_id: 'org', storage: 'test', database: 'app', array: 'items' }

test('Tree initializes through init and exposes no manual flush endpoints', async () => {
    const tree = inspectTree(new Tree())
    assert.equal(typeof tree.init, 'function')
    assert.equal('flushIndex' in tree, false)
    assert.equal('flushLocal' in tree, false)
    assert.equal('flushDisk' in tree, false)
    assert.equal('flushMemory' in tree, false)
    await tree.init({ uuid: 'primary', parent: 'primary', roots: { object: {} }, size: 4, leafSize: 4 })
    assert.equal(tree.config.size, 4)
    assert.equal(tree.config.leafSize, 4)
    await tree.close()
})

test('Tree acknowledges a create batch and indexes the queued leaves in the background', async () => {
    const tree = await createTestTree()
    const inserted = await tree.createLeaves('object', [{ value: 'first' }, { value: 'second' }], envelope)

    assert.equal(inserted.length, 2)
    assert.equal(await tree.leaves.get(inserted[0].uuid), inserted[0])
    assert.ok(tree.pendingIndexCount >= 2)

    await waitForIndex(tree)
    assert.equal(tree.pendingIndexCount, 0)
    const matches = []
    await tree.visitLeaves(async leaf => { if (leaf.value) matches.push(leaf.value) })
    assert.deepEqual(matches.sort(), ['first', 'second'])
})

test('indexed reads do not wait for queued creates and omit them until the indexer catches up', async () => {
    const tree = await createTestTree({ size: 4, leafSize: 4 })
    await tree.createLeaf('object', { value: 'existing' }, envelope)
    await waitForIndex(tree)

    const insertMany = IndexTree.prototype.insertMany
    let startIndexing
    let releaseIndexing
    const started = new Promise(resolve => { startIndexing = resolve })
    const gate = new Promise(resolve => { releaseIndexing = resolve })
    IndexTree.prototype.insertMany = async function(entries) {
        if (this.key === 'value') {
            startIndexing()
            await gate
        }
        return await insertMany.call(this, entries)
    }
    try {
        const queued = await tree.createLeaf('object', { value: 'pending' }, envelope)
        await started
        const branch = await tree.getPrimaryBranch({ ...envelope, method: 'object.read' })
        const plan = planQuery(branch, { value: 'pending' })
        assert.equal(plan.kind, 'query')
        const results = []
        for await (const leaf of tree.getLeaves(plan)) results.push(leaf)
        assert.equal(results.some(leaf => leaf.uuid === queued.uuid), false)

        releaseIndexing()
        await waitForIndex(tree)
        const indexed = []
        for await (const leaf of tree.getLeaves(planQuery(await tree.getPrimaryBranch({ ...envelope, method: 'object.read' }), { value: 'pending' }))) indexed.push(leaf)
        assert.deepEqual(indexed.map(leaf => leaf.uuid), [queued.uuid])
    } finally {
        releaseIndexing()
        IndexTree.prototype.insertMany = insertMany
    }
})

test('queued changes coalesce by leaf and batch entries for the same index tree', async () => {
    const batches = []
    const insertMany = IndexTree.prototype.insertMany
    IndexTree.prototype.insertMany = async function(entries) {
        batches.push({ key: this.key, length: entries.length })
        return await insertMany.call(this, entries)
    }
    try {
        const tree = await createTestTree({ size: 16, leafSize: 16 })
        const leaves = await tree.createLeaves('object', Array.from({ length: 12 }, (_, value) => ({ value, group: 'shared' })), envelope)
        for (const leaf of leaves) {
            await leaf.setValue('group', 'merged')
            await leaf.setValue('group', 'merged')
        }
        await waitForIndex(tree)
        assert.ok(batches.some(batch => batch.key === 'group' && batch.length >= leaves.length))
        const oldEntries = []
        for await (const entry of tree.range('group', 'string', { min: 'shared', max: 'shared' })) oldEntries.push(entry)
        assert.equal(oldEntries.length, 0)
        const currentEntries = []
        for await (const entry of tree.range('group', 'string', { min: 'merged', max: 'merged' })) currentEntries.push(entry)
        assert.equal(currentEntries.length, leaves.length)
    } finally {
        IndexTree.prototype.insertMany = insertMany
    }
})

test('new Tree streams sorted ranges across split branches and updates leaf indexes', async () => {
    const tree = await createTestTree({ size: 4, leafSize: 4 })
    const expected = []
    for (let score = 0; score < 40; score++) {
        expected.push(await tree.createLeaf('object', { name: `item-${score}`, score }, envelope))
    }

    await waitForIndex(tree)
    const entries = []
    for await (const entry of tree.range('score', 'number', { min: 0, max: 39 })) entries.push(entry)
    const rootBranch = (await tree.getPrimaryBranch({ ...envelope, method: 'object.read' })).fields.find(field => field.key === 'score')

    assert.equal(entries.length, 40)
    assert.equal(new Set(entries.map(entry => entry.uuid)).size, 40)
    assert.ok(entries.every((entry, index) => index === 0 || entries[index - 1].value <= entry.value))
    assert.equal(rootBranch.count, 40)
    assert.ok(rootBranch.branches.length > 1)
    const branch = await tree.branches.get(rootBranch.branches[0].uuid)
    const branchEntries = []
    for await (const entry of tree.range('score', 'number', { branchUuid: branch.uuid })) branchEntries.push(entry)
    assert.ok(branchEntries.length > 0 && branchEntries.length < entries.length)

    const matching = []
    const stoppedAfter = await tree.visitRange('score', 'number', { min: 0, max: 39 }, async leaf => {
        if (leaf.score % 2 === 0) matching.push(leaf.score)
        if (matching.length === 3) return Symbol.for('cocreate.db.tree.stop')
    })
    assert.deepEqual(matching, [0, 2, 4])
    assert.equal(stoppedAfter, 5)

    const fullScan = []
    await tree.visitLeaves(async leaf => {
        if (leaf.root === 'object') fullScan.push(leaf.uuid)
    })
    assert.equal(fullScan.length, 40)

    const visited = await tree.visitRange('score', 'number', { min: 0, max: 39 }, async leaf => {
        if (leaf.score === 0) await tree.updateLeaf(leaf.uuid, { score: 41 })
    }, { mutating: true })
    assert.equal(visited, 40)
    await waitForIndex(tree)
    const updated = []
    for await (const leaf of tree.rangeLeaves('score', 'number', { min: 41, max: 41 })) updated.push(leaf.name)
    assert.deepEqual(updated, ['item-0'])
})

test('Tree prunes a complete primary table and hydrates it without disturbing its neighbor', async () => {
    const tree = await createTestTree({ disk: new MemoryDisk(), size: 4, leafSize: 4 })
    const first = [], second = []
    for (let score = 0; score < 20; score++) {
        first.push(await tree.createLeaf('object', { score }, envelope))
        second.push(await tree.createLeaf('object', { score }, { ...envelope, array: 'neighbor' }))
    }
    await waitForIndex(tree)
    const uuid = first[0].parent
    const before = tree.config.indexes.filter(index => index.primary === uuid)
    assert.ok(before.length > 0)
    assert.deepEqual(await tree.prune({ uuid }), { count: 1 })
    assert.equal(tree.pruneCandidates.some(group => group.uuid === uuid), false)
    assert.equal(await tree.leaves.get(second[0].uuid), second[0], 'neighbor remains resident')
    const response = await tree.execute({ ...envelope, method: 'object.read', filter: { query: { score: { $gte: 0 } }, limit: 0 } })
    assert.equal(response.success, true)
    assert.equal(response.object.length, 20)
    assert.notEqual(response.object.find(leaf => leaf.uuid === first[0].uuid), first[0])
    await waitForIndex(tree)
    assert.deepEqual(tree.config.indexes.filter(index => index.primary === uuid), before, 'hydration preserves index UUIDs')
    const updated = await tree.execute({ ...envelope, method: 'object.update', object: { uuid: first[0].uuid, score: 41 } })
    assert.equal(updated.success, true)
    await waitForIndex(tree)
    const read = await tree.execute({ ...envelope, method: 'object.read', filter: { query: { score: 41 } } })
    assert.deepEqual(read.object.map(leaf => leaf.uuid), [first[0].uuid])
    await tree.close()
})

test('Tree protects memory-only data when no recoverable storage is attached', async () => {
    const tree = await createTestTree()
    const leaf = await tree.createLeaf('object', { score: 1 }, envelope)
    await waitForIndex(tree)
    assert.deepEqual(await tree.prune(), { count: 0 })
    assert.equal(await tree.leaves.get(leaf.uuid), leaf)
    await tree.close()
})

test('new Tree persists leaf deletion after the queued index work', async () => {
    const disk = new MemoryDisk()
    const tree = inspectTree(new Tree())
    tree.disk = disk
    await tree.init({ uuid: 'primary', parent: 'primary', roots: { object: {} }, size: 4, leafSize: 4 })
    const leaf = await tree.createLeaf('object', { name: 'remove-me', score: 7 }, envelope)

    await waitForIndex(tree)
    assert.ok(disk.hasLeaf(leaf.uuid))
    assert.ok(disk.events.indexOf('leaf-write') < disk.events.indexOf('branch-write'), 'leaf becomes durable before derived index branches are written')

    await tree.removeLeaf(leaf.uuid)
    assert.equal(await tree.getLeaf(leaf.uuid), undefined)
    assert.ok(disk.hasLeaf(leaf.uuid), 'disk retains the file until the queued index work completes')

    await waitForIndex(tree)
    assert.equal(disk.hasLeaf(leaf.uuid), false)
    assert.ok(disk.events.includes('branch-write'))
    assert.ok(disk.events.includes('leaf-delete'))
    assert.ok(disk.events.lastIndexOf('leaf-delete') < disk.events.lastIndexOf('branch-write'), 'leaf deletion reaches disk before derived index changes')
})


test('nested tables own independent Trees and unfinished storage protects only its own primary', async () => {
    const tree = await createTestTree({ disk: new MemoryDisk(), roots: {
        storage: { database: { array: { child: { object: {} } } } }
    } })
    const scope = { ...envelope, child: 'nested' }
    const nested = await tree.createLeaf('object', { score: 7 }, scope)
    const neighbor = await tree.createLeaf('object', { score: 9 }, { ...scope, array: 'neighbor' })
    await waitForIndex(tree)
    const primary = nested.parent
    let release, entered
    const gate = new Promise(resolve => { release = resolve })
    const started = new Promise(resolve => { entered = resolve })
    tree.persistence = { async execute(request) {
        if (request.kind === 'leaf') { entered(); await gate }
        return request
    } }
    try {
        await tree.updateLeaf(nested.uuid, { score: 8 })
        await started
        assert.deepEqual(await tree.prune({ uuid: primary }), { count: 0 })
        release()
        await waitForIndex(tree)
        assert.deepEqual(await tree.prune({ uuid: primary }), { count: 1 })
        assert.equal(await tree.leaves.get(neighbor.uuid), neighbor)
        const read = await tree.execute({ ...scope, method: 'object.read', filter: { query: { score: 8 } } })
        assert.equal(read.success, true)
        assert.deepEqual(read.object.map(leaf => leaf.uuid), [nested.uuid])
    } finally { release(); await tree.close() }
})
