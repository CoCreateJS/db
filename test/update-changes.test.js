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
const metadata = async db => ({
    database: (await db.send({ ...scope, method: 'database.read' })).database[0],
    array: (await db.send({ ...scope, method: 'array.read' })).array[0]
})

for (const writeBehind of [false, true]) {
    test(`supplied patch is applied unchanged, peers get the patch and clients get the result (writeBehind=${writeBehind})`, async t => {
        const published = [], indexed = []
        const { db, directory } = await fixture(t, { writeBehind, scheduleIndexing: () => {}, onIndexed: item => indexed.push(item),
            partitionAdapter: { get: () => ['peer'] }, documentMutationAdapter: { publish: mutation => published.push(mutation) } })
        const original = (await send(db, 'create', { name: 'Ana', score: 10, old: true, tags: [1], profile: { city: 'Lima' } })).object[0]
        await db.flush()
        published.length = 0; indexed.length = 0
        const patch = Object.freeze({ $inc: Object.freeze({ score: 2 }), $unset: Object.freeze({ old: true }),
            $push: Object.freeze({ tags: 2 }), $set: Object.freeze({ 'profile.city': 'Paris' }) })
        const response = await send(db, 'update', { _id: original._id, name: 'stale data', $update: patch }, { $inc: { score: 100 } })
        assert.equal(response.success, true, response.error)
        const record = response.object[0]
        assert.strictEqual(record.$update, patch)
        assert.equal(record.name, 'Ana', 'the supplied patch is the only mutation input')
        assert.equal(record.score, 12)
        assert.equal('old' in record, false)
        assert.deepEqual(record.tags, [1, 2])
        assert.strictEqual(record.tags, original.tags)
        assert.equal(record.profile.city, 'Paris')
        assert.equal('$update' in original, false, 'delivery metadata stays off the owned record')
        assert.equal('$inc' in response, false)
        await db.flush()
        assert.equal(published.length, 1)
        assert.equal(published[0].operation, 'update')
        assert.strictEqual(published[0].object.$update, patch)
        assert.deepEqual(Object.keys(published[0].object).sort(), ['$update', '_id', 'updated'])
        if (writeBehind) {
            assert.strictEqual(indexed[0].object.$update, patch)
            assert.equal(indexed[0].object.name, 'Ana')
        }
        const { database, array } = await metadata(db)
        const stored = JSON.parse(await readFile(objectPath(directory, database._id, array._id, original._id), 'utf8'))
        assert.equal(stored.score, 12)
        assert.equal(stored.name, 'Ana')
        assert.equal('old' in stored, false)
        assert.equal('$update' in stored, false)
        assert.equal((await db.index.read('changes', 'items', 'score')).indexes.number.length, 1)
        assert.equal((await send(db, 'read', undefined, { filter: { query: { score: 12 } } })).object.length, 1)
    })
}

test('missing patches preserve request operators, globals, array syntax, literal values and undefined deletions', async t => {
    const { db } = await fixture(t)
    const original = (await send(db, 'create', { score: 1, old: true, tags: [1], literal: 'before', untouched: true })).object[0]
    const response = await send(db, 'update', { _id: original._id, old: undefined, 'tags[]': 2, $set: { literal: '$pop' } }, { $inc: { score: 2 } })
    assert.equal(response.success, true, response.error)
    const record = response.object[0], patch = record.$update
    assert.equal(record.score, 3)
    assert.equal(record.literal, '$pop')
    assert.deepEqual(record.tags, [1, 2])
    assert.equal('old' in record, false)
    assert.equal(record.untouched, true)
    assert.deepEqual(patch.$unset, { old: true })
    assert.equal(patch['$inc.score'], 2)
    assert.equal(patch['tags[]'], 2)
    assert.deepEqual(JSON.parse(JSON.stringify(patch)).$unset, { old: true })
})

test('envelope patches work for filtered and multi-object updates and survive response construction', async t => {
    const { db } = await fixture(t)
    const created = (await send(db, 'create', [{ score: 1 }, { score: 2 }])).object
    const patch = { $inc: { score: 2 } }
    const response = await send(db, 'update', created.map(record => ({ _id: record._id })), { $update: patch })
    assert.equal(response.success, true, response.error)
    assert.strictEqual(response.$update, patch)
    for (const record of response.object) assert.strictEqual(record.$update, patch)
    assert.deepEqual(response.object.map(record => record.score), [3, 4])
    const filtered = await db.send({ ...scope, method: 'object.update', filter: { query: { score: 4 } }, $update: { $set: { matched: true } } })
    assert.equal(filtered.success, true, filtered.error)
    assert.equal(filtered.object.length, 1)
    assert.equal(filtered.object[0].matched, true)
})

test('upserts apply their supplied patch and keep transport metadata out of the new record', async t => {
    const { db } = await fixture(t)
    const patch = { $inc: { score: 2 }, $set: { name: 'new' } }
    const response = await send(db, 'update', { _id: '000000000000000000000001', $update: patch }, { upsert: true })
    assert.equal(response.success, true, response.error)
    assert.equal(response.object[0].score, 2)
    assert.strictEqual(response.object[0].$update, patch)
    assert.equal('$update' in (await send(db, 'read', { _id: response.object[0]._id })).object[0], false)
})

test('deferred indexing keeps every increment and append patch rather than replacing pending operations', async t => {
    const published = []
    const { db } = await fixture(t, { writeBehind: true, scheduleIndexing: () => {}, partitionAdapter: { get: () => ['peer'] },
        documentMutationAdapter: { publish: mutation => published.push(mutation) } })
    const original = (await send(db, 'create', { score: 10, tags: [] })).object[0]
    await db.flush()
    published.length = 0
    const first = { $inc: { score: 2 }, $push: { tags: 'first' } }, second = { $inc: { score: -1 }, $push: { tags: 'second' } }
    await send(db, 'update', { _id: original._id, $update: first })
    await send(db, 'update', { _id: original._id, $update: second })
    await db.flush()
    assert.equal(published.length, 2)
    assert.strictEqual(published[0].object.$update, first)
    assert.strictEqual(published[1].object.$update, second)
    assert.equal(original.score, 11)
    assert.deepEqual(original.tags, ['first', 'second'])
})

test('peers apply deltas to their own document, preserve unrelated state and persist the full result', async t => {
    const published = []
    const { db, directory } = await fixture(t, { documentMutationAdapter: { publish: value => published.push(value) } })
    const original = (await send(db, 'create', { score: 20, local: 'keep', old: true })).object[0]
    const envelope = { operation: 'update', ...await metadata(db), createdOn: original.created.on }
    published.length = 0
    const patch = { $inc: { score: 2 }, $unset: { old: true } }
    assert.equal(await db.applyReplicatedObjectMutation({ ...envelope, object: { _id: original._id, $update: patch } }), true)
    const current = await db.readLocalEntity({ type: 'object', databaseId: envelope.database._id, arrayId: envelope.array._id, objectId: original._id })
    assert.strictEqual(current, original)
    assert.equal(current.score, 22)
    assert.equal(current.local, 'keep')
    assert.equal('old' in current, false)
    assert.equal('$update' in current, false)
    assert.equal(published.length, 0, 'replica application must not originate the patch again')
    const stored = JSON.parse(await readFile(objectPath(directory, envelope.database._id, envelope.array._id, original._id), 'utf8'))
    assert.equal(stored.score, 22)
    assert.equal(stored.local, 'keep')
    assert.equal('old' in stored, false)
    assert.equal('$update' in stored, false)
})

test('a missing-base peer acquires current state without applying the included increment twice', async t => {
    let reads = 0
    const { db } = await fixture(t, { peerReader: async request => { reads++; return { _id: request.objectId,
        created: { on: '2026-01-01T00:00:00.000Z' }, score: 12, local: 'snapshot' } } })
    const database = { _id: '000000000000000000000001', name: scope.database }
    const array = { _id: '000000000000000000000002', databaseId: database._id, name: scope.array }
    const id = '000000000000000000000003'
    assert.equal(await db.applyReplicatedObjectMutation({ operation: 'update', database, array, serverId: 'peer',
        createdOn: '2026-01-01T00:00:00.000Z', object: { _id: id, $update: { $inc: { score: 2 } } } }), true)
    const object = await db.readLocalEntity({ type: 'object', databaseId: database._id, arrayId: array._id, objectId: id })
    assert.equal(reads, 1)
    assert.equal(object.score, 12)
    assert.equal(object.local, 'snapshot')
})

test('invalid patches surface ordinary utility errors without mutating the original document', async t => {
    const { db } = await fixture(t)
    const original = (await send(db, 'create', { score: 1 })).object[0]
    const patch = { $notAnOperator: { score: 2 } }
    const response = await send(db, 'update', { _id: original._id, $update: patch })
    assert.equal(response.success, false)
    assert.match(response.error.join('; '), /Shared update utility/)
    assert.equal(original.score, 1)
    assert.deepEqual(patch, { $notAnOperator: { score: 2 } })
})

test('no-op replies retain the patch without scheduling index or persistence work', async t => {
    const { db } = await fixture(t, { writeBehind: true, scheduleIndexing: () => {} })
    const timeStamp = '2026-01-01T00:00:00.000Z'
    const created = await send(db, 'create', { name: 'Ana' }, { timeStamp })
    await db.flush()
    const patch = { $set: { name: 'Ana' } }
    const response = await send(db, 'update', { _id: created.object[0]._id, $update: patch }, { timeStamp })
    assert.equal(response.success, true, response.error)
    assert.equal(response.object[0].name, 'Ana')
    assert.strictEqual(response.object[0].$update, patch)
    assert.equal(db.persistenceStats().pendingIndexes, 0)
    assert.equal(db.persistenceStats().pending, 0)
})
