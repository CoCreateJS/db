import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createUpdate } from '@cocreate/utils'
import { createDB } from '../src/object/index.js'
import { objectPath } from '../src/storage.js'

const scope = { database: 'changes', array: 'items' }
async function fixture(t, options = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'coc-update-changes-'))
    const db = createDB({ directory, memoryCache: true, ...options })
    t.after(async () => { await db.close(); await rm(directory, { recursive: true, force: true }) })
    return { db, directory }
}
const send = (db, method, object, extra = {}) => db.send({ ...scope, method: `object.${method}`, object, ...extra })

for (const writeBehind of [false, true]) {
    test(`update response and propagation contain only changes; persistence stays complete (writeBehind=${writeBehind})`, async t => {
        const published = []
        const indexed = []
        const { db, directory } = await fixture(t, { writeBehind, scheduleIndexing: () => {}, onIndexed: item => indexed.push(item),
            partitionAdapter: { get: () => ['peer'] }, documentMutationAdapter: { publish: mutation => published.push(mutation) } })
        const created = await send(db, 'create', { name: 'Ana', value: 1, profile: { city: 'Lima', email: 'local' }, tags: [1] })
        assert.equal(created.success, true, created.error)
        const original = created.object[0]
        await db.flush()
        published.length = 0; indexed.length = 0
        const response = await send(db, 'update', { _id: original._id, name: 'Ana', value: 1, 'profile.city': 'Paris' })
        assert.equal(response.success, true, response.error)
        const patch = response.object[0]
        assert.equal(patch.$set['profile.city'], 'Paris')
        assert.equal('name' in patch, false)
        assert.equal('name' in patch.$set, false)
        assert.equal('value' in patch.$set, false)
        assert.equal('profile.email' in patch.$set, false)
        const client = structuredClone(original)
        client.profile.email = 'locally edited'
        assert.notEqual(createUpdate(client, { $set: patch.$set, $unset: patch.$unset ?? {} }), false)
        assert.equal(client.profile.email, 'locally edited')
        assert.equal(client.profile.city, 'Paris')
        await db.flush()
        assert.equal(published[0].operation, 'update')
        assert.equal(published[0].object.$set['profile.city'], 'Paris')
        assert.equal('name' in published[0].object.$set, false)
        if (writeBehind) assert.equal('name' in indexed[0].object.$set, false)
        const database = (await db.send({ ...scope, method: 'database.read' })).database[0]
        const array = (await db.send({ ...scope, method: 'array.read' })).array[0]
        const stored = JSON.parse(await readFile(objectPath(directory, database._id, array._id, original._id), 'utf8'))
        assert.equal(stored.name, 'Ana')
        assert.equal(stored.profile.email, 'local')
        assert.equal(stored.profile.city, 'Paris')
        assert.equal('$set' in stored, false)
        assert.deepEqual((await send(db, 'read', { _id: original._id })).object[0].tags, [1])
    })
}

test('resolved changes preserve unset, arrays, literals, and exclude original global operators', async t => {
    const { db } = await fixture(t)
    const original = (await send(db, 'create', { score: 1, old: 'remove', tags: [1], literal: 'before', untouched: true })).object[0]
    const response = await send(db, 'update', { _id: original._id, $unset: { old: true }, $push: { tags: 2 }, $set: { literal: '$pop' } }, { $inc: { score: 2 } })
    assert.equal(response.success, true, response.error)
    assert.equal('$inc' in response, false)
    assert.equal(response.object[0].$set.score, 3)
    assert.equal(response.object[0].$set.literal, '$pop')
    assert.deepEqual(response.object[0].$set.tags, [1, 2])
    assert.deepEqual(response.object[0].$unset, { old: true })
    assert.equal('untouched' in response.object[0].$set, false)
})

test('subscribed nodes merge disjoint updates in either order and preserve their own fields', async t => {
    const { db } = await fixture(t)
    const original = (await send(db, 'create', { a: 1, b: 1, local: 'keep' })).object[0]
    const database = (await db.send({ ...scope, method: 'database.read' })).database[0]
    const array = (await db.send({ ...scope, method: 'array.read' })).array[0]
    const envelope = { operation: 'update', database, array, createdOn: original.created.on }
    for (const changes of [[{ a: 2 }, { b: 3 }], [{ b: 4 }, { a: 5 }]]) {
        for (const $set of changes)
            assert.equal(await db.applyReplicatedObjectMutation({ ...envelope, object: { _id: original._id, $set } }), true)
        const current = (await send(db, 'read', { _id: original._id })).object[0]
        assert.equal(current.a, changes.find(change => change.a).a)
        assert.equal(current.b, changes.find(change => change.b).b)
        assert.equal(current.local, 'keep')
    }
})

test('deferred propagation retains changes that revert before indexing', async t => {
    const published = []
    const { db } = await fixture(t, { writeBehind: true, scheduleIndexing: () => {}, partitionAdapter: { get: () => ['peer'] },
        documentMutationAdapter: { publish: mutation => published.push(mutation) } })
    const original = (await send(db, 'create', { a: 1, b: 1 })).object[0]
    await db.flush()
    published.length = 0
    await send(db, 'update', { _id: original._id, a: 2 })
    await send(db, 'update', { _id: original._id, a: 1 })
    await db.flush()
    assert.equal(published[0].operation, 'update')
    assert.equal(published[0].object.$set.a, 1)
    assert.equal('b' in published[0].object.$set, false)
})

test('a node missing the base fetches a complete snapshot without replaying an older patch', async t => {
    const { db } = await fixture(t, { peerReader: async request => ({ _id: request.objectId, created: { on: '2026-01-01T00:00:00.000Z' }, value: 3, other: 'keep' }) })
    const database = { _id: '000000000000000000000001', name: scope.database }
    const array = { _id: '000000000000000000000002', databaseId: database._id, name: scope.array }
    const id = '000000000000000000000003'
    assert.equal(await db.applyReplicatedObjectMutation({ operation: 'update', database, array, serverId: 'peer', createdOn: '2026-01-01T00:00:00.000Z', object: { _id: id, $set: { value: 2 } } }), true)
    const object = await db.readLocalEntity({ type: 'object', databaseId: database._id, arrayId: array._id, objectId: id })
    assert.equal(object.value, 3)
    assert.equal(object.other, 'keep')
})

test('an unchanged transaction acknowledges identity without scheduling index or persistence work', async t => {
    const { db } = await fixture(t, { writeBehind: true, scheduleIndexing: () => {} })
    const timeStamp = '2026-01-01T00:00:00.000Z'
    const created = await send(db, 'create', { name: 'Ana' }, { timeStamp })
    await db.flush()
    const response = await send(db, 'update', { _id: created.object[0]._id, name: 'Ana' }, { timeStamp })
    assert.equal(response.success, true, response.error)
    assert.deepEqual(response.object[0].$set, {})
    assert.equal('name' in response.object[0], false)
    assert.equal(db.persistenceStats().pendingIndexes, 0)
    assert.equal(db.persistenceStats().pending, 0)
})
