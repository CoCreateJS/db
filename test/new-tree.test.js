import test from 'node:test'
import assert from 'node:assert/strict'
import { Tree, createTree } from '../src/index.js'
import { MemoryDisk } from '../test-support/memory-disk.mjs'

const envelope = { organization_id: 'org', storage: 'test', database: 'app', array: 'items' }

test('Tree creates a batch before deferred indexing and leaves.get returns it by UUID', async () => {
    const tree = await createTree({ deferIndex: true })
    const inserted = await tree.createLeaves('object', [{ value: 'first' }, { value: 'second' }], envelope)

    assert.equal(inserted.length, 2)
    assert.equal(await tree.leaves.get(inserted[0].uuid), inserted[0])
    assert.equal(tree.pendingIndexCount, 2)

    await tree.flushIndex()
    assert.equal(tree.pendingIndexCount, 0)
    const matches = []
    await tree.visitLeaves(async leaf => { if (leaf.value) matches.push(leaf.value) })
    assert.deepEqual(matches.sort(), ['first', 'second'])
})

test('new Tree streams sorted ranges across split branches and updates leaf indexes', async () => {
    const tree = await createTree({ size: 4, leafSize: 4, deferIndex: false })
    const expected = []
    for (let score = 0; score < 40; score++) {
        expected.push(await tree.createLeaf('object', { name: `item-${score}`, score }, envelope))
    }

    await tree.flushIndex()
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
        if (matching.length === 3) return Tree.stop
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
    await tree.flushIndex()
    const updated = []
    for await (const leaf of tree.rangeLeaves('score', 'number', { min: 41, max: 41 })) updated.push(leaf.name)
    assert.deepEqual(updated, ['item-0'])
})

test('Tree pruning releases a bounded number of branches and retains leaves and query paths', async () => {
    const disk = new MemoryDisk()
    const tree = Tree.prepare({ size: 4, leafSize: 4, deferIndex: false })
    tree.disk = disk
    await tree.initialize()
    const leaves = []
    for (let score = 0; score < 40; score++)
        leaves.push(await tree.createLeaf('object', { name: `prune-${score}`, score }, envelope))
    await tree.flushLocal()

    const result = await tree.prune({ limit: 2 })
    assert.equal(result.strategy, 'lfu')
    assert.equal(result.count, 2)
    assert.equal(result.target, 2)
    assert.equal((await Promise.all(leaves.map(leaf => tree.leaves.get(leaf.uuid)))).every((leaf, index) => leaf === leaves[index]), true)

    const entries = []
    for await (const entry of tree.range('score', 'number', { min: 0, max: 39 })) entries.push(entry)
    assert.equal(entries.length, 40)
    await tree.updateLeaf(leaves[0].uuid, { score: 41 })
    await tree.flushIndex()
    const updated = []
    for await (const entry of tree.range('score', 'number', { min: 41, max: 41 })) updated.push(entry.uuid)
    assert.deepEqual(updated, [leaves[0].uuid])
})

test('Tree prune defaults to LFU and an omitted limit prunes every eligible branch', async () => {
    const disk = new MemoryDisk()
    const tree = Tree.prepare({ size: 4, leafSize: 4, deferIndex: false })
    tree.disk = disk
    await tree.initialize()
    for (let score = 0; score < 40; score++)
        await tree.createLeaf('object', { score }, envelope)
    await tree.flushLocal()

    const result = await tree.prune()
    assert.equal(result.strategy, 'lfu')
    assert.equal(result.count, result.candidates)
    assert.ok(result.count > 0)
})

test('Tree can prune and rebuild derived branches without a storage adapter', async () => {
    const tree = Tree.prepare({ size: 4, leafSize: 4, deferIndex: false })
    await tree.initialize()
    const leaves = []
    for (let score = 0; score < 40; score++)
        leaves.push(await tree.createLeaf('object', { score }, envelope))
    await tree.flushIndex()

    const result = await tree.prune()
    assert.ok(result.count > 0)
    assert.equal((await Promise.all(leaves.map(leaf => tree.leaves.get(leaf.uuid)))).every((leaf, index) => leaf === leaves[index]), true)
    const entries = []
    for await (const entry of tree.range('score', 'number', { min: 0, max: 39 })) entries.push(entry)
    assert.equal(entries.length, 40)
    await tree.updateLeaf(leaves[0].uuid, { score: 41 })
    await tree.flushIndex()
    const updated = []
    for await (const entry of tree.range('score', 'number', { min: 41, max: 41 })) updated.push(entry.uuid)
    assert.deepEqual(updated, [leaves[0].uuid])
})

test('new Tree delays local leaf deletion until the index flush boundary', async () => {
    const disk = new MemoryDisk()
    const tree = Tree.prepare({ size: 4, leafSize: 4 })
    tree.disk = disk
    await tree.initialize()
    const leaf = await tree.createLeaf('object', { name: 'remove-me', score: 7 }, envelope)

    await tree.flushLocal()
    assert.ok(disk.hasLeaf(leaf.uuid))
    assert.ok(disk.events.indexOf('leaf-write') < disk.events.indexOf('branch-write'), 'leaf becomes durable before derived index branches are written')

    await tree.removeLeaf(leaf.uuid)
    assert.equal(await tree.getLeaf(leaf.uuid), undefined)
    assert.ok(disk.hasLeaf(leaf.uuid), 'disk retains the file until the complete index cycle is flushed')

    await tree.flushLocal()
    assert.equal(disk.hasLeaf(leaf.uuid), false)
    assert.ok(disk.events.includes('branch-write'))
    assert.ok(disk.events.includes('leaf-delete'))
    assert.ok(disk.events.lastIndexOf('leaf-delete') < disk.events.lastIndexOf('branch-write'), 'leaf deletion reaches disk before derived index changes')
})
