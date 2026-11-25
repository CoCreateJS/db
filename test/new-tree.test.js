import test from 'node:test'
import assert from 'node:assert/strict'
import { Tree, createTree, createStorageDisk } from '../src/index.js'

class MemoryStorage {
    constructor() {
        this.directory = 'memory'
        this.branchDirectory = 'branches'
        this.leafDirectory = 'leaves'
        this.branches = new Map()
        this.leaves = new Map()
        this.events = []
    }

    async initialize() { return this }
    async readBranch(id) { return this.branches.get(id) }
    async writeBranch(id, content) { this.events.push('branch-write'); this.branches.set(id, content) }
    async deleteBranch(id) { this.events.push('branch-delete'); this.branches.delete(id) }
    async hasBranch(id) { return this.branches.has(id) }
    async listBranches() { return [...this.branches.keys()] }
    async readLeaf(id) { return this.leaves.get(id) }
    async writeLeaf(id, content) { this.events.push('leaf-write'); this.leaves.set(id, content) }
    async deleteLeaf(id) { this.events.push('leaf-delete'); this.leaves.delete(id) }
    async hasLeaf(id) { return this.leaves.has(id) }
    async listLeaves() { return [...this.leaves.keys()] }
    async writeConfig() { this.events.push('config-write') }
}

const envelope = { organization_id: 'org', storage: 'test', database: 'app', array: 'items' }

test('Tree leaves.set stores a batch before deferred indexing and leaves.get returns it by UUID', async () => {
    const tree = await createTree({ deferIndex: true })
    const inserted = await tree.leaves.set('object', [{ value: 'first' }, { value: 'second' }], envelope)

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
    const rootBranch = (await tree.getRootBranch()).find(field => field.key === 'score')

    assert.equal(entries.length, 40)
    assert.equal(new Set(entries.map(entry => entry.uuid)).size, 40)
    assert.ok(entries.every((entry, index) => index === 0 || entries[index - 1].value <= entry.value))
    assert.equal(rootBranch.count, 40)
    assert.ok(rootBranch.branches.length > 1)
    const branch = await tree.getBranch('score', 'number', rootBranch.branches[0].uuid)
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

test('new Tree delays local leaf deletion until the index flush boundary', async () => {
    const storage = new MemoryStorage()
    const tree = await createTree({ disk: createStorageDisk(storage), size: 4, leafSize: 4 })
    const leaf = await tree.createLeaf('object', { name: 'remove-me', score: 7 }, envelope)

    await tree.flushLocal()
    assert.ok(storage.leaves.has(leaf.uuid))
    assert.ok(storage.events.indexOf('leaf-write') < storage.events.indexOf('branch-write'), 'leaf becomes durable before derived index branches are written')

    await tree.removeLeaf(leaf.uuid)
    assert.equal(await tree.getLeaf(leaf.uuid), undefined)
    assert.ok(storage.leaves.has(leaf.uuid), 'disk retains the file until the complete index cycle is flushed')

    await tree.flushLocal()
    assert.equal(storage.leaves.has(leaf.uuid), false)
    assert.ok(storage.events.includes('branch-write'))
    assert.ok(storage.events.includes('leaf-delete'))
    assert.ok(storage.events.lastIndexOf('leaf-delete') < storage.events.lastIndexOf('branch-write'), 'leaf deletion reaches disk before derived index changes')
})
