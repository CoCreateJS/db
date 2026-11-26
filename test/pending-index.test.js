import test from 'node:test'
import assert from 'node:assert/strict'
import { createRootManager } from '../src/tree/manager.js'
import { createConfiguration } from '../src/runtime.js'
import { Tree as IndexTree } from '../src/tree/btree.js'
import { waitForIndex } from './benchmarks/shared/wait-for-index.mjs'

async function setup() {
    const db = { config: createConfiguration({ roots: { array: { object: {} } } }), leaves: new Map(), tree: new Map() }
    const manager = await createRootManager({ db })
    const parent = await manager.create({ name: 'items' }, undefined, 'array')
    const leaves = await manager.createMany([{ status: 'initial', score: 0 }, { status: 'deleted' }], parent, 'object')
    const resource = { get pendingIndexCount() { return manager.pendingIndex.size } }
    await waitForIndex(resource)
    return { db, manager, parent, leaves, resource }
}

test('pending index records group by parent UUID, coalesce fields, and serialize deletions', async () => {
    const { db, manager, parent, leaves, resource } = await setup()
    try {
        const [changed, removed] = leaves
        await changed.setValue('status', 'updated')
        await changed.setValue('status', 'final')
        await changed.setValue('score', 1)
        await manager.remove(removed)
        const snapshot = JSON.parse(JSON.stringify(manager.pendingIndex))
        assert.deepEqual(Object.keys(snapshot), [parent.uuid])
        assert.deepEqual(snapshot[parent.uuid][changed.uuid], { operation: 'write', paths: ['status', 'score'] })
        assert.deepEqual(snapshot[parent.uuid][removed.uuid], { operation: 'delete', paths: null })
        assert.equal(manager.pendingIndex.size, 2)
        assert.equal(manager.pendingIndex.has(removed), true)
        assert.equal(db.deleted.get(removed.uuid), removed)
        await waitForIndex(resource)
        assert.equal(db.deleted.has(removed.uuid), false)
        assert.deepEqual(JSON.parse(JSON.stringify(manager.pendingIndex)), {})
        assert.equal(db.leaves.has(removed.uuid), false)
        const entries = []
        for await (const entry of db.tree.get('status').get('string').scan()) entries.push(entry)
        assert.equal(entries.some(entry => entry.uuid === removed.uuid), false)
        assert.equal(entries.find(entry => entry.uuid === changed.uuid).value, 'final')
    } finally { await manager.close() }
})

test('a new change while indexing remains queued and visible in the serializable pending records', async () => {
    const { db, manager, parent, leaves, resource } = await setup()
    const insertMany = IndexTree.prototype.insertMany
    let release, entered
    const blocked = new Promise(resolve => { release = resolve })
    const started = new Promise(resolve => { entered = resolve })
    let pause = true
    IndexTree.prototype.insertMany = async function(entries) {
        if (pause) { pause = false; entered(); await blocked }
        return insertMany.call(this, entries)
    }
    try {
        const leaf = leaves[0]
        await leaf.setValue('status', 'in-flight')
        await started
        await leaf.setValue('score', 3)
        const snapshot = JSON.parse(JSON.stringify(manager.pendingIndex))
        assert.equal(manager.pendingIndex.size, 1)
        assert.deepEqual(snapshot[parent.uuid][leaf.uuid].paths.sort(), ['score', 'status'])
        release()
        await waitForIndex(resource)
        assert.equal(manager.pendingIndex.size, 0)
        const entries = []
        for await (const entry of db.tree.get('score').get('number').scan()) entries.push(entry)
        assert.equal(entries.find(entry => entry.uuid === leaf.uuid).value, 3)
    } finally {
        release()
        IndexTree.prototype.insertMany = insertMany
        await manager.close()
    }
})

test('deleting an in-flight leaf retains its cleanup references until the delete batch completes', async () => {
    const { db, manager, parent, leaves, resource } = await setup()
    const insertMany = IndexTree.prototype.insertMany
    let release, entered
    const blocked = new Promise(resolve => { release = resolve })
    const started = new Promise(resolve => { entered = resolve })
    let pause = true
    IndexTree.prototype.insertMany = async function(entries) {
        if (pause) { pause = false; entered(); await blocked }
        return insertMany.call(this, entries)
    }
    try {
        const leaf = leaves[0]
        await leaf.setValue('status', 'in-flight')
        await started
        await manager.remove(leaf)
        const snapshot = JSON.parse(JSON.stringify(manager.pendingIndex))
        assert.equal(snapshot[parent.uuid][leaf.uuid].operation, 'delete')
        assert.equal(manager.pendingIndex.size, 1)
        release()
        await waitForIndex(resource)
        assert.equal(db.deleted.size, 0)
        assert.equal(db.leaves.has(leaf.uuid), false)
        for await (const entry of db.tree.get('status').get('string').scan()) assert.notEqual(entry.uuid, leaf.uuid)
    } finally {
        release()
        IndexTree.prototype.insertMany = insertMany
        await manager.close()
    }
})
