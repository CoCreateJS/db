import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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
    test(`update response, propagation, and persistence contain the complete resolved document (writeBehind=${writeBehind})`, async t => {
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
        const record = response.object[0]
        assert.strictEqual(record, original)
        assert.equal(record.profile.city, 'Paris')
        assert.equal(record.profile.email, 'local')
        assert.equal(record.name, 'Ana')
        assert.equal(record.value, 1)
        assert.deepEqual(record.tags, [1])
        assert.equal('$set' in record, false)
        assert.equal('$unset' in record, false)
        await db.flush()
        assert.equal(published[0].operation, 'update')
        assert.strictEqual(published[0].object, record)
        if (writeBehind) assert.strictEqual(indexed[0].object, record)
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

test('resolved documents preserve final values and removals without exposing update operators', async t => {
    const { db } = await fixture(t)
    const original = (await send(db, 'create', { score: 1, old: 'remove', tags: [1], literal: 'before', untouched: true })).object[0]
    const response = await send(db, 'update', { _id: original._id, $unset: { old: true }, $push: { tags: 2 }, $set: { literal: '$pop' } }, { $inc: { score: 2 } })
    assert.equal(response.success, true, response.error)
    assert.equal('$inc' in response, false)
    assert.equal(response.object[0].score, 3)
    assert.equal(response.object[0].literal, '$pop')
    assert.deepEqual(response.object[0].tags, [1, 2])
    assert.equal('old' in response.object[0], false)
    assert.equal(response.object[0].untouched, true)
    assert.equal('$set' in response.object[0], false)
    assert.equal('$unset' in response.object[0], false)
})

test('subscribed nodes install complete documents and remove fields absent from the new state', async t => {
    const { db, directory } = await fixture(t)
    const original = (await send(db, 'create', { a: 1, b: 1, local: 'keep' })).object[0]
    const database = (await db.send({ ...scope, method: 'database.read' })).database[0]
    const array = (await db.send({ ...scope, method: 'array.read' })).array[0]
    const envelope = { operation: 'update', database, array, createdOn: original.created.on }
    const replacement = { _id: original._id, created: original.created, a: 2, b: 3 }
    assert.equal(await db.applyReplicatedObjectMutation({ ...envelope, object: replacement }), true)
    const current = await db.readLocalEntity({ type: 'object', databaseId: database._id, arrayId: array._id, objectId: original._id })
    assert.strictEqual(current, original)
    assert.equal(current.a, 2)
    assert.equal(current.b, 3)
    assert.equal('local' in current, false)
    await db.flush()
    const stored = JSON.parse(await readFile(objectPath(directory, database._id, array._id, original._id), 'utf8'))
    assert.equal(stored.a, 2)
    assert.equal(stored.b, 3)
    assert.equal('local' in stored, false)
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
    assert.equal(published[0].object.a, 1)
    assert.equal(published[0].object.b, 1)
    assert.equal('$set' in published[0].object, false)
})

test('a node missing the base installs the delivered document without fetching or replaying operators', async t => {
    const { db } = await fixture(t, { peerReader: async () => { throw Error('A full update needs no base fetch') } })
    const database = { _id: '000000000000000000000001', name: scope.database }
    const array = { _id: '000000000000000000000002', databaseId: database._id, name: scope.array }
    const id = '000000000000000000000003'
    assert.equal(await db.applyReplicatedObjectMutation({ operation: 'update', database, array, serverId: 'peer', createdOn: '2026-01-01T00:00:00.000Z', object: { _id: id, created: { on: '2026-01-01T00:00:00.000Z' }, value: 3, other: 'keep' } }), true)
    const object = await db.readLocalEntity({ type: 'object', databaseId: database._id, arrayId: array._id, objectId: id })
    assert.equal(object.value, 3)
    assert.equal(object.other, 'keep')
    await assert.rejects(db.applyReplicatedObjectMutation({ operation: 'update', database, array,
        object: { _id: id, created: object.created, $inc: { value: 1 } } }), /without update operators/)
    assert.equal(object.value, 3)
})

test('an unchanged transaction acknowledges identity without scheduling index or persistence work', async t => {
    const { db } = await fixture(t, { writeBehind: true, scheduleIndexing: () => {} })
    const timeStamp = '2026-01-01T00:00:00.000Z'
    const created = await send(db, 'create', { name: 'Ana' }, { timeStamp })
    await db.flush()
    const response = await send(db, 'update', { _id: created.object[0]._id, name: 'Ana' }, { timeStamp })
    assert.equal(response.success, true, response.error)
    assert.strictEqual(response.object[0], created.object[0])
    assert.equal(response.object[0].name, 'Ana')
    assert.equal('$set' in response.object[0], false)
    assert.equal(db.persistenceStats().pendingIndexes, 0)
    assert.equal(db.persistenceStats().pending, 0)
})

test('an update with no matching namespace does not echo global update operators', async t => {
    const { db } = await fixture(t)
    const response = await send(db, 'update', { _id: '000000000000000000000001' }, { $inc: { value: 1 } })
    assert.equal(response.success, true, response.error)
    assert.deepEqual(response.object, [])
    assert.equal('$inc' in response, false)
})
