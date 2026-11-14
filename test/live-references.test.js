import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { access } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createDB } from '../src/object/index.js'
import { initializeServerDB } from '../src/server.js'
import { readMemoryJSON, removeMemoryPath } from '../src/memory.js'
import { setImmediate } from 'node:timers/promises'

const base = { organization_id: '000000000000000000000001', storage: 'dev', database: 'app', array: 'files' }
const directory = () => `/tmp/coc-live-memory-${randomUUID()}`
const send = (db, method, object, extra = {}) => db.send({ ...base, method: `object.${method}`, object, ...extra })

test('cache CRUD retains the input, nested objects, arrays, and read results without cloning or disk I/O', async t => {
    const root = directory()
    const db = createDB({ directory: root, memoryOnly: true, scheduleIndexing: () => {} })
    t.after(async () => { await db.close(); removeMemoryPath(root) })
    t.mock.method(globalThis, 'structuredClone', () => { throw Error('Cloning is forbidden') })
    const input = { pathname: '/index.html', host: ['*'], profile: { city: 'Lima' }, tags: [1], score: 1 }
    const profile = input.profile, tags = input.tags
    const created = await send(db, 'create', input)
    assert.equal(created.success, true, created.error)
    assert.strictEqual(created.object[0], input)
    await db.flush()
    for await (const entry of db.index.scan('app', 'files', 'tags'))
        assert.strictEqual(entry.value, tags, 'array-valued indexes reuse the stored array')
    const first = await send(db, 'read', undefined, { filter: { query: { pathname: '/index.html' } } })
    assert.strictEqual(first.object[0], input)
    const updated = await send(db, 'update', { _id: input._id, 'profile.city': 'Paris', $push: { tags: 2 }, $inc: { score: 2 } })
    assert.equal(updated.success, true, updated.error)
    assert.strictEqual(input.profile, profile)
    assert.strictEqual(input.tags, tags)
    assert.equal(profile.city, 'Paris')
    assert.deepEqual(tags, [1, 2])
    assert.equal(first.object[0].score, 3)
    assert.strictEqual(updated.object[0].tags, tags)
    await send(db, 'update', { _id: input._id, $pull: { tags: 1 } })
    assert.strictEqual(input.tags, tags)
    assert.deepEqual(tags, [2])
    await db.flush()
    assert.equal((await send(db, 'read', undefined, { filter: { query: { 'profile.city': 'Lima' } } })).object.length, 0)
    assert.strictEqual((await send(db, 'read', undefined, { filter: { query: { 'profile.city': 'Paris' } } })).object[0], input)
    const excluded = (await send(db, 'read', { _id: input._id }, { filter: { key: { 'profile.city': 0 } } })).object[0]
    assert.equal(excluded.profile.city, undefined)
    assert.equal(profile.city, 'Paris', 'projection must not delete from the live record')
    assert.strictEqual(excluded.tags, tags)
    await assert.rejects(access(root), { code: 'ENOENT' })
})

test('invalid updates are rejected before attachment and preserve live identities', async t => {
    const root = directory()
    const db = createDB({ directory: root, memoryOnly: true, scheduleIndexing: () => {} })
    t.after(async () => { await db.close(); removeMemoryPath(root) })
    const value = { tags: [1, 2], text: 'not a number' }
    await send(db, 'create', value)
    const tags = value.tags
    const response = await send(db, 'update', { _id: value._id, 'new.branch.value': 'prepared', $push: { tags: 3 }, $inc: { text: 1 } })
    assert.equal(response.success, false)
    assert.strictEqual(value.tags, tags)
    assert.deepEqual(tags, [1, 2])
    assert.equal(value.new, undefined, 'a prepared branch is never attached on validation failure')
    const date = value.created.on
    assert.equal((await send(db, 'update', { _id: value._id, 'created.on': '1900-01-01T00:00:00.000Z' })).success, false)
    assert.equal(value.created.on, date)
})

test('a structural failure remains inspectable without an endless background retry or tree rollback', async t => {
    const root = directory()
    let fail = false, attempts = 0
    const db = createDB({ directory: root, memoryOnly: true, nodeId: 'local', partitionAdapter: {
        onLocalChange: (event, apply) => {
            if (fail && event.path.startsWith('indexes/')) { attempts++; throw Error('interrupted index publication') }
            return apply({ partitionId: event.path, nodeId: 'local', operation: event.operation === 'remove' ? 'remove' : 'add' })
        }
    } })
    t.after(async () => { fail = false; await db.close(); removeMemoryPath(root) })
    const value = { value: 1 }
    await send(db, 'create', value)
    await db.flush()
    t.mock.timers.enable({ apis: ['setTimeout'] })
    fail = true
    const response = await send(db, 'update', { _id: value._id, value: 2 })
    assert.equal(response.success, true, response.error)
    t.mock.timers.tick(0)
    await setImmediate()
    assert.equal(attempts, 1)
    assert.match(db.persistenceStats().indexError, /interrupted index publication/)
    assert.equal(value.value, 2, 'an applied local value is not rolled back for publication failure')
    t.mock.timers.tick(5000)
    await setImmediate()
    assert.equal(attempts, 1, 'the same failure is not rebuilt repeatedly without new work')
    fail = false
    await db.flush()
    assert.equal(db.persistenceStats().pendingIndexes, 0)
})

test('repeated reads reuse completed indexes and do not schedule indexing or distribution writes', async t => {
    const root = directory(), indexed = [], partitions = []
    const db = createDB({ directory: root, memoryOnly: true, nodeId: 'local', scheduleIndexing: () => {},
        onIndexed: event => indexed.push(event), partitionAdapter: { onLocalChange: (event, apply) => {
            partitions.push(event)
            return apply({ partitionId: event.path, nodeId: 'local', operation: event.operation === 'remove' ? 'remove' : 'add' })
        } } })
    t.after(async () => { await db.close(); removeMemoryPath(root) })
    const value = { pathname: '/index.html', host: ['*'], src: 'hello' }
    await send(db, 'create', value)
    await db.flush()
    await send(db, 'read', { _id: value._id })
    const before = { indexed: indexed.length, partitions: partitions.length }
    for (let i = 0; i < 50; i++) {
        const response = await send(db, 'read', undefined, { filter: { query: { host: { $in: ['dev.example.com', '*'] }, pathname: '/index.html' } } })
        assert.strictEqual(response.object[0], value)
    }
    assert.equal(db.persistenceStats().pendingIndexes, 0)
    assert.equal(indexed.length, before.indexed)
    assert.equal(partitions.length, before.partitions)
})

test('partition delivery updates the cached node in place with either index-cache setting', async t => {
    for (const cache of [false, true]) {
        const root = directory()
        const db = createDB({ directory: root, memoryOnly: true, cache, scheduleIndexing: () => {} })
        t.after(async () => { await db.close(); removeMemoryPath(root) })
        await send(db, 'create', { value: 1 })
        await db.flush()
        const database = (await db.send({ ...base, method: 'database.read' })).database[0]
        const array = (await db.send({ ...base, method: 'array.read' })).array[0]
        const node = (await db.index.read('app', 'files', 'value')).indexes.number
        const path = `indexes/${node.id}.json`
        // Deserialization is the transport boundary; receiving does not clone it again.
        const incoming = JSON.parse(JSON.stringify(node))
        incoming.entries[0][0] = 2
        incoming.first.value = incoming.last.value = 2
        const result = await db.applyIndexPartition(path, incoming)
        assert.strictEqual(result, node)
        assert.strictEqual((await db.index.read('app', 'files', 'value')).indexes.number, node)
        assert.equal(node.entries[0][0], 2)
    }
})

test('index nodes split in place, retain identity, and accept indivisible large values', async t => {
    const root = directory()
    const db = createDB({ directory: root, memoryOnly: true, maxIndexBytes: 1024, scheduleIndexing: () => {} })
    t.after(async () => { await db.close(); removeMemoryPath(root) })
    t.mock.method(globalThis, 'structuredClone', () => { throw Error('Cloning is forbidden') })
    const first = { rank: 0, src: 'a'.repeat(50000) }
    await send(db, 'create', first)
    await db.flush()
    const valueRoot = (await db.index.read('app', 'files', 'rank')).indexes.number
    for (let i = 1; i < 35; i++) await send(db, 'create', { rank: i, src: `${i}-` + 'b'.repeat(50000) })
    await db.flush()
    const databaseRead = await db.send({ ...base, method: 'database.read' })
    assert.equal(databaseRead.success, true, databaseRead.error)
    const database = databaseRead.database[0]
    const arrayRead = await db.send({ ...base, method: 'array.read' })
    assert.equal(arrayRead.success, true, arrayRead.error)
    const array = arrayRead.array[0]
    const path = `${root}/indexes/${valueRoot.id}.json`
    assert.strictEqual(await readMemoryJSON(path), valueRoot, 'the original leaf is mutated rather than replaced')
    assert.equal((await send(db, 'read', undefined, { filter: { query: { rank: { $gte: 0 } } } })).object.length, 35)
    assert.equal(db.persistenceStats().pendingIndexes, 0)
    await assert.rejects(access(root), { code: 'ENOENT' })
})

test('scoped primary propagation retains patch references without replacing their operation operands', async t => {
    const root = directory(), published = []
    const server = Object.assign(new EventEmitter(), { id: 'local', isPrimary: true,
        workers: Object.assign(new Map(), { distribution: new Map() }), send: async value => value,
        cluster: Object.assign(new EventEmitter(), { send: value => published.push(value) }) })
    const db = initializeServerDB(server, { directory: root, memoryOnly: true,
        bootstrapPersistence: { name: 'must-not-be-used', provider: 'invalid-provider' } })
    t.after(async () => { await db.close(); removeMemoryPath(root) })
    t.mock.method(globalThis, 'structuredClone', () => { throw Error('Cloning is forbidden') })
    const input = { pathname: '/index.html', tags: [1], value: 1 }
    const created = await send(db, 'create', input)
    assert.equal(created.success, true, created.error)
    await db.flush()
    const ns = await db.forScope(base)
    const database = (await ns.send({ ...base, method: 'database.read' })).database[0]
    const array = (await ns.send({ ...base, method: 'array.read' })).array[0]
    await ns.updateDistribution({ databaseId: database._id, arrayId: array._id, objectId: input._id, nodeId: 'peer', operation: 'add' })
    for (const { partitionId } of await ns.listPartitions())
        await ns.updatePartition({ partitionId, nodeId: 'peer', operation: 'add' })
    const patch = { value: 2, $push: { tags: 2 } }
    const response = await send(db, 'update', { _id: input._id, $update: patch })
    await db.flush()
    const mutation = published.find(value => value.method === 'db.object.mutation' && value.operation === 'update')
    assert.ok(mutation)
    assert.strictEqual(mutation.object.$update, patch)
    assert.strictEqual(response.object[0].tags, input.tags)
    await send(db, 'update', { _id: input._id, value: 3, $push: { tags: 3 } })
    assert.equal(mutation.object.$update.value, 2)
    assert.equal(mutation.object.$update.$push.tags, 2)
    assert.deepEqual(input.tags, [1, 2, 3])
    assert.equal(JSON.parse(JSON.stringify(mutation)).object.$update.value, 2)
    await assert.rejects(access(root), { code: 'ENOENT' })
})
