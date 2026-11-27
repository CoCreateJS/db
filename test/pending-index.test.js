import test from 'node:test'
import assert from 'node:assert/strict'
import { createManager } from '../src/tree/manager.js'
import { createConfiguration } from '../src/runtime.js'
import { Tree as IndexTree } from '../src/tree/btree.js'
import { waitForIdle } from './benchmarks/shared/wait-for-index.mjs'

async function setup() {
    const db = { config: createConfiguration({ roots: { object: {} }, parent: 'primary' }), leaves: new Map(), tree: new Map() }
    const parent = { uuid: 'primary' }
    const manager = await createManager({ db, owner: { uuid: parent.uuid, active: 0, weight: 0 } })
    const leaves = await manager.createMany('object', [{ status: 'initial', score: 0 }, { status: 'deleted' }])
    const resource = { get pendingIndexCount() { return manager.pendingIndex.size }, get pendingDiskCount() { return manager.disk.size } }
    await waitForIdle(resource)
    return { db, manager, parent, leaves, resource }
}

test('each primary Tree owns flat pending index records that coalesce fields, and serialize deletions', async () => {
    const { db, manager, parent, leaves, resource } = await setup()
    try {
        const [changed, removed] = leaves
        await changed.setValue('status', 'updated')
        await changed.setValue('status', 'final')
        await changed.setValue('score', 1)
        await manager.remove(removed)
        const snapshot = JSON.parse(JSON.stringify(manager.pendingIndex))
        assert.deepEqual(Object.keys(snapshot).sort(), [changed.uuid, removed.uuid].sort())
        assert.deepEqual(snapshot[changed.uuid], { operation: 'write', paths: ['status', 'score'] })
        assert.deepEqual(snapshot[removed.uuid], { operation: 'delete', paths: null })
        assert.equal(manager.pendingIndex.size, 2)
        assert.equal(manager.pendingIndex.has(removed), true)
        assert.equal(db.deleted.get(removed.uuid), removed)
        await waitForIdle(resource)
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
        assert.deepEqual(snapshot[leaf.uuid].paths.sort(), ['score', 'status'])
        release()
        await waitForIdle(resource)
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
        assert.equal(snapshot[leaf.uuid].operation, 'delete')
        assert.equal(manager.pendingIndex.size, 1)
        release()
        await waitForIdle(resource)
        assert.equal(db.deleted.size, 0)
        assert.equal(db.leaves.has(leaf.uuid), false)
        for await (const entry of db.tree.get('status').get('string').scan()) assert.notEqual(entry.uuid, leaf.uuid)
    } finally {
        release()
        IndexTree.prototype.insertMany = insertMany
        await manager.close()
    }
})
