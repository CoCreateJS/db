import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Tree } from '../src/tree/index.js'
import { LocalTier } from '../src/tree/local.js'
import { MemoryPolicy } from '../src/tree/memory.js'
import createDB from '../src/index.js'
import { updateArtifact } from '../src/artifact.js'

test('memory policy follows the finer ladder and starts one index weight group per pass', async () => {
    const calls = []
    const local = { async evictLowestWeight() { calls.push(['index']); return { count: 0 } } }
    const artifacts = { async evictBatch(limit) { calls.push(['artifact', limit]); return { count: 0 } } }
    const policy = new MemoryPolicy(local, {systemMemory: 4000}, artifacts)
    for (const [i, pressure] of [.04, .05, .10, .20, .40, .60, .80, .90, 1].entries()) {
        policy.check(i * 100, pressure * 1000)
        await policy.flush()
        assert.equal(policy.stage, i)
    }
    assert.deepEqual(policy.samples.map(sample => sample.threshold), [.05, .10, .20, .40, .60, .80, .90, 1])
    assert.deepEqual(calls.filter(([kind]) => kind === 'artifact').map(([, limit]) => limit), [64,128,512])
    assert.equal(calls.filter(([kind]) => kind === 'index').length, 8)
})

test('requests at the budget bypass the interval and coalesce during an active batch', async () => {
    let release
    let calls = 0
    const local = {
        evictLowestWeight() {
            calls++
            return new Promise(resolve => { release = resolve })
        }
    }
    const artifactLimits = []
    const artifacts = { async evictBatch(limit) { artifactLimits.push(limit) } }
    const policy = new MemoryPolicy(local, {systemMemory: 4000}, artifacts)
    const releaseBatch = async () => {
        release({ count: 0 })
        await new Promise(setImmediate)
    }

    policy.check(0, 900)
    const running = policy.index.job
    await new Promise(setImmediate)
    policy.check(1, 1000)
    policy.check(2, 1400)
    await new Promise(setImmediate)
    assert.equal(policy.index.job, running)
    assert.equal(policy.stage, 8)
    assert.equal(calls, 1)
    assert.deepEqual(artifactLimits, [128, 512, 512])

    await releaseBatch()
    assert.equal(calls, 2)
    assert.deepEqual(artifactLimits, [128, 512, 512])
    await releaseBatch()
    await policy.flush()
    assert.deepEqual(policy.samples.map(({ rss }) => rss), [900, 1400])

    policy.check(3, 1000)
    await new Promise(setImmediate)
    assert.equal(calls, 3)
    await releaseBatch()
    await policy.flush()

    policy.check(103, 980)
    await new Promise(setImmediate)
    assert.equal(policy.stage, 8)
    await releaseBatch()
    await policy.flush()
    policy.check(203, 970)
    await new Promise(setImmediate)
    assert.equal(policy.stage, 7)
    await releaseBatch()
    await policy.flush()
})

test('a below-budget request clears pending high-pressure work', async () => {
    let release
    let calls = 0
    const local = {
        evictLowestWeight() {
            calls++
            return new Promise(resolve => { release = resolve })
        }
    }
    const policy = new MemoryPolicy(local, {systemMemory: 4000})
    policy.check(0, 1000)
    await new Promise(setImmediate)
    policy.check(1, 1000)
    policy.check(2, 900)
    release({ count: 0 })
    await policy.flush()
    assert.equal(calls, 1)
})

test('index writes leave view weight alone and invalidate an in-flight offload', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cocreatedb-index-eviction-'))
    try {
        const entries = new Map()
        const local = new LocalTier(directory, id => entries.get(id))
        const tree = new Tree(8, local, 'status')
        function insert(value) {
            const entry = { uuid: String(value), value }
            entries.set(entry.uuid, entry)
            tree.insert(entry)
            return entry
        }

        const first = insert(1)
        assert.equal(tree.root.viewed, 0)
        const stale = local.evictLowestWeight()
        const second = insert(2)
        assert.equal(tree.root.viewed, 0)
        assert.equal((await stale).count, 0)
        assert.equal(tree.root.onDisk, false)
        assert.equal(local.writes, 0)

        assert.equal((await local.evictLowestWeight()).count, 1)
        assert.equal(tree.root.onDisk, true)
        assert.deepEqual([...tree.scan(1, 2)], [first, second])
        assert.equal(local.reads, 1)
        assert.equal(tree.root.viewed, 1)
        tree.remove(first)
        assert.equal(tree.root.viewed, 1)
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test('offload releases live entries and restores only the affected field index', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cocreatedb-detached-entries-'))
    try {
        const db = createDB({}, { directory, memoryPolicy: false, size: 4 })
        const scope = { organization_id: 'org', storage: 'local', database: 'db', array: 'contacts' }
        const send = (action, input) => db.send({ ...scope, method: 'object.' + action, ...input })
        const created = await send('create', {
            object: Array.from({ length: 8 }, (_, value) => ({ uuid: 'contact-' + value, status: value, notes: value }))
        })
        assert.equal(created.success, true)
        db.flushIndex()

        const contact = created.object[0]
        const oldStatus = contact.getIndex('status')
        const oldNotes = contact.getIndex('notes')
        const statusLeaf = oldStatus.partition
        const notesLeaf = oldNotes.partition

        // Changes waiting for deferred reconciliation still need the old entry value.
        const pendingOffload = db.local.evictOne(statusLeaf)
        updateArtifact(created.object[1], { status: 101 })
        assert.equal(await pendingOffload, false)
        db.flushIndex()

        assert.equal(statusLeaf.toDisk(), true)
        assert.equal(await db.local.evictOne(notesLeaf), true)
        assert.equal(oldStatus.partition, null)
        assert.equal(oldNotes.partition, null)
        assert.equal(Object.hasOwn(statusLeaf, 'entries'), false)
        assert.equal(contact.notes, 0)
        assert.equal(db.local.reads, 0)

        const read = await send('read', { filter: { query: { status: 0 }, limit: 1 } })
        assert.equal(read.object[0], contact)
        assert.equal(db.local.reads, 1)
        assert.equal(notesLeaf.onDisk, true)

        assert.equal(await contact.toDisk(), true)
        assert.equal(statusLeaf.toDisk(), true)
        const restored = contact.getIndex('status')
        assert.notEqual(restored, oldStatus)
        assert.equal(restored.partition, statusLeaf)
        assert.equal(restored.value, 0)
        assert.equal(db.artifactTier.reads, 0)
        assert.equal(notesLeaf.onDisk, true)

        const updated = await send('update', { object: { uuid: contact.uuid, status: 99 } })
        assert.equal(updated.success, true)
        db.flushIndex()
        assert.equal(notesLeaf.onDisk, true)
        assert.deepEqual((await send('read', { filter: { query: { status: 0 } } })).object, [])
        assert.equal((await send('read', { filter: { query: { status: 99 } } })).object[0], contact)

        const deleted = await send('delete', { object: { uuid: contact.uuid } })
        assert.equal(deleted.success, true)
        db.flushIndex()
        assert.deepEqual((await send('read', { filter: { query: { notes: 0 } } })).object, [])
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})
