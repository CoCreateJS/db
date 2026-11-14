import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { getDistribution } from '@cocreate/utils/distribution'
import { createDB, initializeServerDB } from '../src/index.js'

const scope = { organization_id: '000000000000000000000001', storage: 'production', database: 'app', array: 'items' }
async function fixture(t, server) {
    const directory = await mkdtemp(join(tmpdir(), 'db-distribution-'))
    const db = server ? initializeServerDB(server, { directory, writeBehind: false }) : createDB({ directory })
    t.after(async () => { await db.close(); await rm(directory, { recursive: true, force: true }) })
    return db
}
const intersects = (a, b) => a.some(key => b.includes(key))

test('ordinary CRUD reuses stable document distribution and list interest includes future objects', async t => {
    const db = await fixture(t)
    const send = data => db.send({ ...scope, ...data })
    const created = await send({ method: 'object.create', object: [{ name: 'first' }, { name: 'second' }] })
    assert.equal(created.success, true, created.error)
    const [first, second] = created.object
    const read = await send({ method: 'object.read', object: { _id: first._id } })
    assert.equal(read.distribution.length, 1)
    assert.ok(read.distribution[0].endsWith(`/objects/${first._id}.json`))
    const repeat = await send({ method: 'object.read', object: first._id, databaseId: 'untrusted', distribution: ['untrusted'] })
    assert.deepEqual(repeat.distribution, read.distribution)
    const unrelated = await send({ method: 'object.update', object: { _id: second._id, name: 'changed' } })
    assert.equal(intersects(read.distribution, unrelated.distributionKeys), false)
    const update = await send({ method: 'object.update', object: { _id: first._id, name: 'updated' } })
    assert.equal(intersects(read.distribution, update.distributionKeys), true)
    const empty = await send({ method: 'object.read', filter: { query: { name: 'future' } } })
    assert.equal(empty.object.length, 0)
    const future = await send({ method: 'object.create', object: { name: 'future' } })
    assert.equal(intersects(empty.distribution, future.distributionKeys), true)
    const other = await send({ array: 'other', method: 'object.create', object: { _id: first._id } })
    assert.equal(intersects(read.distribution, other.distributionKeys), false)
    await send({ method: 'array.update', name: 'renamed' })
    const renamed = await send({ array: 'renamed', method: 'object.read', object: { _id: first._id } })
    assert.deepEqual(renamed.distribution, read.distribution)
    const removed = await send({ array: 'renamed', method: 'object.delete', object: { _id: first._id } })
    assert.equal(intersects(read.distribution, removed.distributionKeys), true)
})

test('primary registers every worker using a distribution; errors cannot register supplied references', async t => {
    const server = Object.assign(new EventEmitter(), { id: 'distribution-node', isPrimary: true, workerId: 1,
        cluster: Object.assign(new EventEmitter(), { send() {} }), send: async payload => payload })
    await fixture(t, server)
    const request = server.listeners('db.send')[0]
    const create = await request({ workerId: 2, data: { ...scope, method: 'object.create', object: { name: 'one' } } })
    const data = { ...scope, method: 'object.read', object: { _id: create.result.object[0]._id } }
    const first = await request({ workerId: 2, data })
    const second = await request({ workerId: 4, data })
    assert.deepEqual(first.result.distribution, second.result.distribution)
    assert.deepEqual([...getDistribution(server.workers.distribution, first.result.distribution)].sort(), [2, 4])
    await request({ workerId: 4, data })
    assert.equal(getDistribution(server.workers.distribution, first.result.distribution).size, 2)
    const failed = await request({ workerId: 9, data: { ...data, organization_id: 'invalid', distribution: first.result.distribution } })
    assert.equal(failed.result.success, false)
    assert.equal(failed.result.distribution, undefined)
    assert.equal(getDistribution(server.workers.distribution, first.result.distribution).has(9), false)
})

test('applied peer changes deliver CRUD through the same references outside the DB operation queue', { timeout: 5000 }, async t => {
    const delivered = []
    let db
    const server = Object.assign(new EventEmitter(), { id: 'target', isPrimary: true,
        cluster: Object.assign(new EventEmitter(), { send() {} }),
        send: async payload => {
            if (payload.method === 'object.update') {
                // Socket authorization can query DB while delivering a peer change.
                const read = await db.send({ ...scope, method: 'object.read', object: { _id: payload.object[0]._id } })
                assert.equal(read.object[0].value, 7)
                delivered.push(payload)
            }
            return payload
        } })
    db = await fixture(t, server)
    const registered = await server.listeners('db.send')[0]({ workerId: 3,
        data: { ...scope, method: 'object.create', object: { value: 1 } } })
    const record = registered.result.object[0]
    const storageId = registered.result.storageId
    const database = (await db.send({ ...scope, method: 'database.read' })).database[0]
    const array = (await db.send({ ...scope, method: 'array.read' })).array[0]
    const patch = { $inc: { value: 6 } }
    await server.cluster.listeners('db.object.mutation')[0]({
        serverId: 'source', targets: ['target'], operation: 'update',
        scope: { organization_id: scope.organization_id, storageId, storage: scope.storage },
        database, array, createdOn: record.created.on,
        object: { _id: record._id, $update: patch }
    })
    assert.equal(delivered.length, 1)
    assert.deepEqual(delivered[0].worker, [3])
    assert.ok(intersects(registered.result.distribution, delivered[0].distributionKeys))
    assert.equal(delivered[0].object[0].value, 7)
    assert.equal(delivered[0].object[0]._id, record._id)
    assert.equal('$set' in delivered[0].object[0], false)
    assert.equal('$unset' in delivered[0].object[0], false)
    assert.strictEqual(delivered[0].object[0].$update, patch)
})
