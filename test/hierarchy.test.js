import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, access, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDB, initializeServerDB, fileId } from '../src/index.js'
import { EventEmitter } from 'node:events'

const org = '000000000000000000000001'
const other = '000000000000000000000002'
const scope = { organization_id: org, storage: 'production', database: 'app', array: 'items' }
async function fixture(t, options = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'coc-hierarchy-'))
    const db = createDB({ directory, memoryCache: true, ...options })
    t.after(async () => { await db.close(); await rm(directory, { recursive: true, force: true }) })
    return { db, directory }
}
const send = (db, method, extra = {}) => db.send({ ...scope, method, ...extra })

test('requires resolved organization/storage/database and never invents namespace defaults', async t => {
    const { db } = await fixture(t)
    for (const key of ['organization_id', 'storage', 'database']) {
        const response = await send(db, 'object.read', { [key]: undefined })
        assert.equal(response.success, false)
        assert.match(response.error.join('; '), new RegExp(key))
    }
    assert.equal((await send(db, 'object.read', { storage: ['production', 'test'] })).success, false)
    assert.equal((await send(db, 'object.read', { organization_id: '../escape' })).success, false)
})

for (const writeBehind of [false, true]) test(`organization/storage/database isolate identical document IDs (writeBehind=${writeBehind})`, async t => {
    const { db, directory } = await fixture(t, { writeBehind })
    const objectId = '000000000000000000000009'
    const scopes = [scope, { ...scope, storage: 'development' }, { ...scope, database: 'other' }, { ...scope, organization_id: other }]
    for (let i = 0; i < scopes.length; i++) {
        const response = await db.send({ ...scopes[i], method: 'object.create', object: { _id: objectId, value: i } })
        assert.equal(response.success, true, response.error)
        assert.deepEqual(response.object[0].$storage, [scopes[i].storage])
    }
    for (let i = 0; i < scopes.length; i++) {
        const read = await db.send({ ...scopes[i], method: 'object.read', object: { _id: objectId } })
        assert.equal(read.object[0].value, i)
    }
    await db.flush()
    const record = (await send(db, 'storage.read')).storage[0]
    assert.notEqual(record._id, 'production')
    const database = (await send(db, 'database.read')).database.find(item => item.name === 'app')
    const array = (await send(db, 'array.read')).array[0]
    const file = join(directory, org, 'objects', `${fileId((await send(db, 'object.read', { object: objectId })).object[0])}.json`)
    assert.equal(JSON.parse(await readFile(file, 'utf8')).value, 0)
    await assert.rejects(access(join(directory, org, 'storages', 'production')), { code: 'ENOENT' })
})

test('renaming storage changes the name reference and preserves directory/database/array/object IDs', async t => {
    const { db, directory } = await fixture(t)
    const made = await send(db, 'object.create', { object: { value: 1 } })
    const storage = (await send(db, 'storage.read')).storage[0]
    const database = (await send(db, 'database.read')).database.find(item => item.name === 'app')
    const renamed = await send(db, 'storage.update', { name: 'renamed' })
    assert.equal(renamed.success, true, renamed.error)
    assert.equal(renamed.storage[0]._id, storage._id)
    assert.deepEqual((await send(db, 'object.read')).object, [])
    const read = await send(db, 'object.read', { storage: 'renamed' })
    assert.equal(read.object[0]._id, made.object[0]._id)
    assert.equal((await send(db, 'database.read', { storage: 'renamed' })).database[0]._id, database._id)
    await access(join(directory, org, 'databases', `${fileId(database)}.json`))
})

test('concurrent first writes share one stable storage reference', async t => {
    const { db } = await fixture(t)
    const results = await Promise.all(Array.from({ length: 4 }, (_, value) => send(db, 'object.create', { object: { value } })))
    assert.ok(results.every(item => item.success))
    assert.equal((await send(db, 'object.read')).object.length, 4)
})

test('primary runtime keeps fully scoped partition paths and entity availability', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'coc-hierarchy-runtime-'))
    const events = []
    const server = Object.assign(new EventEmitter(), { id: 'node', isPrimary: true, cluster: new EventEmitter() })
    server.cluster.send = payload => events.push(payload)
    server.send = async payload => {
        const results = await Promise.all(server.rawListeners(payload.method).map(listener => listener(payload)))
        return results[0] ?? payload
    }
    const db = initializeServerDB(server, { directory })
    t.after(async () => { await db.close(); await rm(directory, { recursive: true, force: true }) })
    const made = await send(db, 'object.create', { object: { value: 1 } })
    assert.equal(made.success, true, made.error)
    await db.flush()
    assert.ok(events.some(event => event.method === 'db.distribution' && event.scope?.organization_id === org && event.scope?.storageId))
    const partitions = await db.listPartitions()
    assert.ok(partitions.length)
    assert.ok(partitions.every(item => item.partitionId.startsWith(`${org}/indexes/`)))
    for (const partition of partitions) assert.ok(await db.readIndexPartition(partition.partitionId))
})

test('replicated storage metadata preserves the same ID and propagates renames without moving payloads', async t => {
    const source = await fixture(t)
    const target = await fixture(t)
    await send(source.db, 'storage.create')
    const record = (await send(source.db, 'storage.read')).storage[0]
    await target.db.applyStorageMutation({ organization_id: org, storageId: record._id, storageFileId: fileId(record), operation: 'set', record: JSON.parse(JSON.stringify(record)) })
    const created = await send(target.db, 'object.create', { object: { value: 9 } })
    const renamed = (await send(source.db, 'storage.update', { name: 'development' })).storage[0]
    await target.db.applyStorageMutation({ organization_id: org, storageId: record._id, storageFileId: fileId(record), operation: 'set', record: JSON.parse(JSON.stringify(renamed)) })
    const read = await send(target.db, 'object.read', { storage: 'development' })
    assert.equal(read.object[0]._id, created.object[0]._id)
    assert.equal(read.storageId, record._id)
    assert.deepEqual((await send(target.db, 'object.read')).object, [])
})
