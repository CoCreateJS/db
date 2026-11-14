import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDB } from '../src/object/index.js'
import { initializeServerDB } from '../src/server.js'
import { removeMemoryPath } from '../src/memory.js'

const gate = () => {
    let resolve
    const promise = new Promise(done => { resolve = done })
    return { promise, resolve }
}
const soon = async promise => {
    let timer
    try {
        return await Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(Error('Requester waited for backend work')), 1500)
        })])
    } finally { clearTimeout(timer) }
}
const scope = { organization_id: '000000000000000000000001', storage: 'dev', database: 'app', array: 'items' }

test('read completes filtering, sorting, pagination, and projection before background client registration', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'coc-ack-read-'))
    const entered = gate(), release = gate()
    const server = Object.assign(new EventEmitter(), { id: 'self', isPrimary: true,
        cluster: Object.assign(new EventEmitter(), { send() {} }),
        send: async payload => {
            if (payload.method === 'db.distribution.set') {
                entered.resolve()
                await release.promise
                return { success: false, error: ['registration failed after read'] }
            }
            return payload
        } })
    const db = initializeServerDB(server, { directory })
    t.after(async () => { release.resolve(); await db.close(); removeMemoryPath(directory); await rm(directory, { recursive: true, force: true }) })
    await db.send({ ...scope, method: 'object.create', object: [0, 1, 2, 3].map(rank => ({ rank, hidden: 'private' })) })
    await db.flush()
    const response = await soon(db.send({ ...scope, clientId: 'reader', method: 'object.read',
        filter: { query: { rank: { $gte: 1 } }, sort: [{ key: 'rank', direction: 'desc' }], startingIndex: 1, limit: 1, key: { rank: 1 } }
    }, { workerId: 2 }))
    assert.equal(response.success, true, response.error)
    assert.deepEqual(response.object.map(value => value.rank), [2])
    assert.equal(response.object[0].hidden, undefined)
    assert.equal(response.filter.storages[0].count, 3)
    await soon(entered.promise)
    release.resolve()
    await db.flush()
    assert.equal(response.success, true)
    assert.equal(response.error, undefined)
    assert.deepEqual(db.persistenceStats().backgroundError.error, ['registration failed after read'])
})

test('create acknowledges memory before metadata work; blocked backend does not prevent update or read', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'coc-ack-metadata-'))
    const entered = gate(), release = gate()
    let blocked = false
    const db = createDB({ directory, memoryOnly: true, nodeId: 'self', scheduleIndexing: () => {},
        partitionAdapter: { onLocalChange: async (payload, apply) => {
            if (blocked) { entered.resolve(); await release.promise }
            return apply({ partitionId: payload.path, nodeId: 'self', operation: payload.operation === 'remove' ? 'remove' : 'add' })
        } } })
    t.after(async () => { blocked = false; release.resolve(); await db.close(); removeMemoryPath(directory); await rm(directory, { recursive: true, force: true }) })
    await db.send({ ...scope, method: 'array.create' })
    blocked = true
    const value = { counter: 1 }
    const created = await soon(db.send({ ...scope, method: 'object.create', object: value }))
    assert.equal(created.success, true, created.error)
    assert.strictEqual(created.object[0], value)
    const flushing = db.flush()
    await soon(entered.promise)
    const updated = await soon(db.send({ ...scope, method: 'object.update', object: { _id: value._id, $update: { $inc: { counter: 1 } } } }))
    assert.equal(updated.success, true, updated.error)
    assert.equal(value.counter, 2)
    const read = await soon(db.send({ ...scope, method: 'object.read', object: { _id: value._id } }))
    assert.strictEqual(read.object[0], value)
    release.resolve(); blocked = false
    await flushing
    await db.flush()
})

for (const phase of ['peers', 'registration', 'disk']) test(`blocked ${phase} never holds create/update acknowledgment or the primary request queue`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'coc-ack-server-'))
    const entered = gate(), release = gate()
    let blocked = false, diskWrites = 0
    const server = Object.assign(new EventEmitter(), { id: 'self', workerId: 1, isPrimary: true,
        cluster: Object.assign(new EventEmitter(), { send: async () => {
            if (blocked && phase === 'peers') { entered.resolve(); await release.promise }
        } }),
        send: async payload => {
            if (blocked && phase === 'registration' && payload.method === 'db.distribution.set') {
                entered.resolve(); await release.promise
            }
            if (phase === 'registration' && payload.method === 'db.distribution.set')
                return { success: false, error: ['registration rejected after acknowledgment'] }
            return payload
        } })
    const db = initializeServerDB(server, { directory, persistenceOptions: { write: async () => {
        if (blocked && phase === 'disk') { entered.resolve(); await release.promise }
        diskWrites++
    } } })
    t.after(async () => { blocked = false; release.resolve(); await db.close(); removeMemoryPath(directory); await rm(directory, { recursive: true, force: true }) })
    await db.send({ ...scope, method: 'array.create' })
    await db.flush()
    const before = diskWrites
    blocked = true
    const created = await soon(db.send({ ...scope, clientId: 'client', method: 'object.create', object: { counter: 1 } }, { workerId: 2 }))
    assert.equal(created.success, true, created.error)
    const id = created.object[0]._id
    const flushing = db.flush()
    await soon(entered.promise)
    assert.equal(diskWrites, before, 'pending backend delivery is not allowed to persist this revision yet')
    const updated = await soon(db.send({ ...scope, clientId: 'client', method: 'object.update', object: { _id: id, $update: { $inc: { counter: 1 } } } }, { workerId: 2 }))
    assert.equal(updated.success, true, updated.error)
    assert.equal(updated.object[0].counter, 2)
    const read = await soon(db.send({ ...scope, clientId: 'read-client', method: 'object.read', object: { _id: id } }, { workerId: 2 }))
    assert.equal(read.success, true, read.error)
    assert.equal(read.object[0].counter, 2)
    const deleted = await soon(db.send({ ...scope, clientId: 'delete-client', method: 'object.delete', object: { _id: id } }, { workerId: 2 }))
    assert.equal(deleted.success, true, deleted.error)
    assert.equal(deleted.object[0]._id, id)
    assert.deepEqual((await soon(db.send({ ...scope, method: 'object.read', object: { _id: id } }))).object, [])
    release.resolve(); blocked = false
    await flushing
    await db.flush()
    assert.ok(diskWrites > before)
    assert.equal(created.success, true)
    assert.equal(updated.success, true)
    assert.equal(read.success, true)
    assert.equal(deleted.success, true)
    assert.equal(created.error, undefined)
    if (phase === 'registration')
        assert.deepEqual(db.persistenceStats().backgroundError.error, ['registration rejected after acknowledgment'])
})

test('an internal metadata failure remains background state and cannot change completed success', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'coc-ack-error-'))
    let fail = false
    const db = createDB({ directory, memoryOnly: true, nodeId: 'self', scheduleIndexing: () => {},
        partitionAdapter: { onLocalChange: (payload, apply) => {
            if (fail) throw Error('backend metadata failed')
            return apply({ partitionId: payload.path, nodeId: 'self', operation: 'add' })
        } } })
    t.after(async () => { fail = false; await db.close(); removeMemoryPath(directory); await rm(directory, { recursive: true, force: true }) })
    await db.send({ ...scope, method: 'array.create' })
    fail = true
    const response = await soon(db.send({ ...scope, method: 'object.create', object: { counter: 1 } }))
    assert.equal(response.success, true)
    await assert.rejects(db.flush(), /backend metadata failed/)
    assert.equal(response.success, true)
    assert.equal(response.error, undefined)
    assert.match(db.persistenceStats().indexError, /backend metadata failed/)
})

test('delete acknowledges removal without serializing index values, and immediate ID reuse resolves the new memory record', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'coc-ack-delete-'))
    const db = createDB({ directory, memoryOnly: true, scheduleIndexing: () => {} })
    t.after(async () => { t.mock.restoreAll(); await db.close(); removeMemoryPath(directory); await rm(directory, { recursive: true, force: true }) })
    const value = { counter: 1, tags: ['index-cleanup-belongs-after-response'] }
    await db.send({ ...scope, method: 'object.create', object: value })
    await db.flush()
    const stringify = JSON.stringify
    t.mock.method(JSON, 'stringify', function (input, ...args) {
        if (input === value.tags[0]) assert.fail('Delete computed array index cleanup before responding')
        return stringify.call(this, input, ...args)
    })
    const removed = await soon(db.send({ ...scope, method: 'object.delete', object: { _id: value._id } }))
    assert.equal(removed.success, true, removed.error)
    t.mock.restoreAll()
    assert.deepEqual((await db.send({ ...scope, method: 'object.read', object: { _id: value._id } })).object, [])
    const created = await db.send({ ...scope, method: 'object.create', object: { _id: value._id, counter: 2 } })
    assert.equal(created.success, true, created.error)
    const updated = await db.send({ ...scope, method: 'object.update', object: { _id: value._id, $update: { $inc: { counter: 1 } } } })
    assert.equal(updated.success, true, updated.error)
    assert.equal(updated.object[0].counter, 3)
    await db.flush()
    assert.equal((await db.send({ ...scope, method: 'object.read', object: { _id: value._id } })).object[0].counter, 3)
})
