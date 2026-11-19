import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { initializeServerDB } from '../src/index.js'
import { createDB } from '../src/object/index.js'
import { removeMemoryPath } from '../src/memory.js'

const scope = { database: 'stages', array: 'items' }
const gate = () => {
    let resolve
    const promise = new Promise(done => { resolve = done })
    return { promise, resolve }
}
async function diskWrite({ path, operation, value, options }) {
    if (operation === 'remove') return rm(path, { ...options, force: true })
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(value))
}
async function fixture(t, options = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'coc-db-stages-'))
    const db = createDB({ directory, memoryCache: true, writeBehind: true, scheduleIndexing: () => {}, ...options })
    t.after(async () => { await db.close(); await rm(directory, { recursive: true, force: true }) })
    return { db, directory }
}
const send = (db, method, object, filter) => db.send({ ...scope, method: `object.${method}`, ...(object === undefined ? {} : { object }), ...(filter ? { filter } : {}) })
async function coldRead(directory, query) {
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
        import { createDB } from ${JSON.stringify(new URL('../src/object/index.js', import.meta.url).href)};
        const result = await createDB({ directory: process.env.TEST_DB_DIRECTORY }).send({
            database: 'stages', array: 'items', method: 'object.read', filter: { query: JSON.parse(process.env.TEST_QUERY) }
        });
        if (!result.success) throw Error(result.error);
        console.log(JSON.stringify(result.object));
    `], { env: { ...process.env, TEST_DB_DIRECTORY: directory, TEST_QUERY: JSON.stringify(query) } })
    return JSON.parse(stdout)
}

test('responds before indexing/disk and queries include pending creates, updates, and deletes', async t => {
    const writes = []
    const { db, directory } = await fixture(t, { persistenceOptions: { write: async item => { writes.push(item.path); await diskWrite(item) } } })
    const created = await send(db, 'create', { value: 1, tags: [1, 2] })
    assert.equal(created.success, true, created.error)
    const id = created.object[0]._id
    assert.equal(db.persistenceStats().pendingIndexes, 1)
    assert.equal(writes.length, 0)
    assert.equal((await send(db, 'read', undefined, { query: { value: 1 } })).object.length, 1)
    const updated = await send(db, 'update', { _id: id, value: 2 })
    assert.equal(updated.success, true)
    assert.equal((await send(db, 'read', undefined, { query: { value: 2 } })).object[0].value, 2)
    assert.deepEqual((await send(db, 'read', undefined, { query: { value: 1 } })).object, [])
    assert.equal(writes.length, 0)
    await db.flush()
    assert.equal(db.persistenceStats().pendingIndexes, 0)
    assert.equal((await coldRead(directory, { value: 2 }))[0]._id, id)
    assert.deepEqual(await coldRead(directory, { value: 1 }), [])
    assert.equal((await send(db, 'delete', { _id: id })).success, true)
    assert.deepEqual((await send(db, 'read', { _id: id })).object, [])
    await db.flush()
    assert.deepEqual(await coldRead(directory, {}), [])
})

test('failed indexing rolls back partial memory nodes, retains the document, and retries', async t => {
    let fail = false
    const { db, directory } = await fixture(t, {
        nodeId: 'local',
        partitionAdapter: { onLocalChange: async (payload, apply) => {
            if (fail && payload.path.startsWith('indexes/')) { fail = false; throw new Error('index interrupted') }
            return apply({ partitionId: payload.path, nodeId: 'local', operation: payload.operation === 'remove' ? 'remove' : 'add' })
        } }
    })
    const created = await send(db, 'create', { value: 1 })
    assert.equal(created.success, true, created.error)
    const id = created.object[0]._id
    await db.flush()
    fail = true
    assert.equal((await send(db, 'update', { _id: id, value: 2 })).success, true)
    await assert.rejects(db.flush(), /index interrupted/)
    assert.equal(db.persistenceStats().pendingIndexes, 1)
    assert.equal((await send(db, 'read', undefined, { query: { value: 2 } })).object[0].value, 2)
    assert.deepEqual((await send(db, 'read', undefined, { query: { value: 1 } })).object, [])
    assert.equal((await coldRead(directory, {}))[0].value, 1, 'Failed indexing has not reached persistence')
    await db.flush()
    assert.deepEqual(await coldRead(directory, { value: 1 }), [])
    assert.equal((await coldRead(directory, { value: 2 }))[0].value, 2)
})

test('sequential persistence resolves latest addresses and an old acknowledgment cannot clear a newer write', async t => {
    const entered = gate(), finishDisk = gate(), storageEntered = gate(), finishStorage = gate()
    let id, active = 0, maxActive = 0, block = false
    const versions = []
    const { db, directory } = await fixture(t, { persistenceOptions: {
        write: async item => {
            active++; maxActive = Math.max(maxActive, active)
            try {
                if (block && item.path.endsWith(`/${id}.json`)) { block = false; entered.resolve(); await finishDisk.promise }
                await diskWrite(item)
            } finally { active-- }
        },
        storage: async item => {
            if (item.value?._id === id) {
                versions.push(item.value.value)
                if (item.value.value === 1) { storageEntered.resolve(); await finishStorage.promise }
            }
        }
    } })
    const created = await send(db, 'create', { value: 0 })
    id = created.object[0]._id
    await db.flush()
    block = true
    await send(db, 'update', { _id: id, value: 1 })
    const flushing = db.flush()
    await entered.promise
    await send(db, 'update', { _id: id, value: 2 })
    await send(db, 'update', { _id: id, value: 3 })
    removeMemoryPath(directory)
    assert.equal((await send(db, 'read', { _id: id })).object[0].value, 3, 'Dirty memory cannot be evicted')
    finishDisk.resolve()
    await storageEntered.promise
    assert.ok(db.persistenceStats().pending > 0, 'Disk completion alone cannot clear required storage work')
    finishStorage.resolve()
    await flushing
    assert.ok(db.persistenceStats().pending > 0, 'Revision 1 acknowledgment leaves revision 3 dirty')
    await db.flush()
    assert.equal(maxActive, 1)
    assert.deepEqual(versions, [0, 1, 3], 'Queued updates coalesce to the latest value')
    assert.equal((await coldRead(directory, {}))[0].value, 3)
})

test('required storage failures retain pending work for retry after disk succeeds', async t => {
    let fail = false
    const { db, directory } = await fixture(t, { persistenceOptions: { storage: async () => {
        if (fail) throw new Error('storage offline')
    } } })
    const created = await send(db, 'create', { value: 1 })
    await db.flush()
    fail = true
    await send(db, 'update', { _id: created.object[0]._id, value: 2 })
    await assert.rejects(db.flush(), /storage offline/)
    assert.ok(db.persistenceStats().pending > 0)
    removeMemoryPath(directory)
    assert.equal((await send(db, 'read', { _id: created.object[0]._id })).object[0].value, 2)
    fail = false
    await db.flush()
    assert.equal(db.persistenceStats().pending, 0)
})

test('split indexes, array chunks, deleted/recreated IDs, and array deletion persist correctly', async t => {
    const { db, directory } = await fixture(t, { maxIndexBytes: 1024 })
    const objects = []
    for (let i = 0; i < 5; i++) {
        const result = await send(db, 'create', { value: i, tags: Array.from({ length: 100 }, (_, j) => `item-${i}-${j}`) })
        assert.equal(result.success, true, result.error)
        objects.push(result.object[0])
    }
    await db.flush()
    const id = objects[0]._id
    assert.equal((await send(db, 'delete', { _id: id })).success, true)
    assert.equal((await send(db, 'create', { _id: id, value: 100, tags: ['replacement'] })).success, true)
    await db.flush()
    assert.equal((await coldRead(directory, { value: 100 }))[0]._id, id)
    assert.deepEqual(await coldRead(directory, { tags: 'item-0-0' }), [])
    const removed = await db.send({ ...scope, method: 'array.delete' })
    assert.equal(removed.success, true, removed.error)
    await db.flush()
    assert.deepEqual(await coldRead(directory, {}), [])
})

test('primary dispatches completed indexing through IPC/Mesh before blocked disk persistence', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'coc-db-order-'))
    const entered = gate(), finish = gate(), indexed = gate()
    const events = []
    const server = Object.assign(new EventEmitter(), { id: 'ordering-node', isPrimary: true, cluster: new EventEmitter() })
    server.cluster.send = payload => events.push(payload.method)
    server.send = async payload => {
        if (payload.method === 'db.indexed') { events.push(payload.method); indexed.resolve() }
        const replies = await Promise.all(server.rawListeners(payload.method).map(listener => listener(payload)))
        return replies[0] ?? payload
    }
    const db = initializeServerDB(server, { directory, persistenceOptions: { write: async item => {
        events.push('disk'); entered.resolve(); await finish.promise; await diskWrite(item)
    } } })
    t.after(async () => { finish.resolve(); await db.close(); await rm(directory, { recursive: true, force: true }) })
    assert.equal((await db.send({ ...scope, organization_id: '000000000000000000000001', storage: 'production', method: 'object.create', object: { value: 1 } })).success, true)
    events.push('response')
    await indexed.promise
    await entered.promise
    assert.ok(events.indexOf('response') < events.indexOf('db.indexed'))
    assert.ok(events.indexOf('db.indexed') < events.indexOf('disk'))
    assert.ok(events.indexOf('db.partition.availability') < events.indexOf('disk'))
    finish.resolve()
    await db.flush()
})

test('deletion markers reject late updates and peer copies; upsert starts a new created.on lifetime', async t => {
    let staleObject, peerReads = 0
    const { db, directory } = await fixture(t, { nodeId: 'local', peerReader: async () => { peerReads++; return staleObject } })
    const created = await send(db, 'create', { value: 1 })
    staleObject = created.object[0]
    const id = staleObject._id
    await db.flush()
    const database = (await db.send({ database: scope.database, method: 'database.read' })).database[0]
    const array = (await db.send({ ...scope, method: 'array.read' })).array[0]
    const metadata = { database, array }
    const changedCreation = await send(db, 'update', { _id: id, 'created.on': '2099-01-01T00:00:00.000Z' })
    assert.equal(changedCreation.success, false)
    assert.equal((await send(db, 'delete', { _id: id })).success, true)
    await db.flush()
    const marker = JSON.parse(await readFile(join(directory, 'databases', database._id, 'arrays', array._id, 'deleted', `${id}.json`), 'utf8'))
    assert.equal(marker.created.on, staleObject.created.on)
    const late = await send(db, 'update', { _id: id, value: 2 })
    assert.equal(late.success, false)
    assert.match(late.error.join('; '), /not found/)
    assert.equal(await db.applyReplicatedObjectMutation({ ...metadata, operation: 'set', object: staleObject }), false)
    await db.updateDistribution({ databaseId: database._id, arrayId: array._id, objectId: id, nodeId: 'peer', operation: 'add' })
    assert.deepEqual((await send(db, 'read', { _id: id })).object, [])
    assert.ok(peerReads > 0)
    const upserted = await db.send({ ...scope, method: 'object.update', upsert: true, object: { _id: id, value: 3, created: staleObject.created } })
    assert.equal(upserted.success, true, upserted.error)
    assert.ok(upserted.object[0].created.on > staleObject.created.on)
    assert.equal(await db.applyReplicatedObjectMutation({ ...metadata, operation: 'set', object: staleObject }), false)
    assert.equal(await db.applyReplicatedObjectMutation({ ...metadata, operation: 'remove', object: staleObject }), false)
    await db.flush()
    assert.equal((await coldRead(directory, {}))[0].value, 3)
})

test('configured storage workflow acknowledges snapshots and can query CRUD during shutdown drain', { timeout: 5000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'coc-db-storage-workflow-'))
    const calls = []
    const server = Object.assign(new EventEmitter(), { id: 'workflow-node', isPrimary: true,
        organization_id: 'test-organization', host: 'example.test', cluster: new EventEmitter() })
    server.cluster.send = () => {}
    server.send = async payload => {
        const replies = await Promise.all(server.rawListeners(payload.method).map(listener => listener(payload)))
        return replies[0] ?? payload
    }
    const db = initializeServerDB(server, { directory, storageWorkflow: 'save-test' })
    server.workflow = { run: async (payload, options) => {
        calls.push(payload)
        assert.equal(payload.method, 'workflow.save-test')
        assert.equal(payload.organization_id, server.organization_id)
        assert.equal(options, undefined)
        assert.ok(payload.storage[0].path)
        // A workflow loads its definition through CRUD. This must not deadlock.
        const result = await db.send({ ...scope, organization_id: '000000000000000000000001', storage: 'production', method: 'object.read' })
        assert.equal(result.success, true)
        return { success: true }
    } }
    t.after(async () => { await db.close(); await rm(directory, { recursive: true, force: true }) })
    assert.equal((await db.send({ ...scope, organization_id: '000000000000000000000001', storage: 'production', method: 'object.create', object: { value: 1 } })).success, true)
    await db.close()
    assert.ok(calls.length > 0)
    assert.ok(calls.some(payload => payload.storage[0].value?.value === 1))
    assert.equal((await send(db, 'update', { value: 2 })).success, false)
})
