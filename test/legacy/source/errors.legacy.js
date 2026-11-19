import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import { createDB } from '../src/object/index.js'
import { createDB as createScopedDB } from '../src/scoped.js'
import { initializeServerDB } from '../src/server.js'
import { removeMemoryPath } from '../src/memory.js'

const scope = { organization_id: '000000000000000000000001', storage: 'dev', database: 'app', array: 'items' }
function fixture(t, send = async data => data) {
    const directory = `/tmp/coc-errors-${randomUUID()}`
    const server = Object.assign(new EventEmitter(), { id: 'target', isPrimary: true,
        cluster: Object.assign(new EventEmitter(), { send() {} }), send })
    const db = initializeServerDB(server, { directory, memoryOnly: true })
    t.after(async () => { await db.close(); removeMemoryPath(directory) })
    t.mock.method(console, 'error', () => assert.fail('DB must report errors without console logging'))
    return { db, server }
}

test('engine and scoped request failures append errors without discarding earlier failures', async t => {
    for (const create of [createDB, createScopedDB]) {
        const directory = `/tmp/coc-error-request-${randomUUID()}`
        const db = create({ directory, memoryOnly: true })
        t.after(async () => { await db.close(); removeMemoryPath(directory) })
        const error = ['upstream failed']
        const response = await db.send({ ...scope, organization_id: 'invalid', method: 'object.invalid', error })
        assert.equal(response.success, false)
        assert.strictEqual(response.error, error)
        assert.equal(response.error[0], 'upstream failed')
        assert.equal(response.error.length, 2)
    }
})

test('replication failures return accumulated error arrays and expose them in background status', async t => {
    const { db, server } = fixture(t)
    const response = await server.cluster.listeners('db.partition.update')[0]({
        method: 'db.partition.update', serverId: 'peer', path: 'invalid', value: {}, error: ['upstream failed']
    })
    assert.equal(response.success, false)
    assert.equal(response.error[0], 'upstream failed')
    assert.equal(response.error.length, 2)
    assert.deepEqual(db.persistenceStats().backgroundError, { method: 'db.partition.update', error: response.error })
})

test('synchronous transport failures append to the event envelope instead of logging', async t => {
    const { db, server } = fixture(t)
    server.cluster.send = () => { throw Error('Mesh unavailable') }
    const response = await server.cluster.listeners('db.distribution.sync')[0]({
        method: 'db.distribution.sync', serverId: 'peer', inventory: { entities: [], partitions: [] }, error: ['earlier failure']
    })
    assert.equal(response.success, false)
    assert.deepEqual(response.error, ['earlier failure', 'Mesh unavailable'])
    assert.deepEqual(db.persistenceStats().backgroundError.error, response.error)
})

test('notification failures remain inspectable without turning a completed mutation into a retry', async t => {
    const { db } = fixture(t, async () => { throw Error('notification unavailable') })
    const created = await db.send({ ...scope, method: 'object.create', object: { value: 1 } })
    assert.equal(created.success, true)
    await db.flush()
    await setImmediate()
    assert.deepEqual(db.persistenceStats().backgroundError, { method: 'db.indexed', error: ['notification unavailable'] })
    assert.equal(db.persistenceStats().pendingIndexes, 0)
})

test('worker proxy preserves error arrays returned by the primary', async () => {
    const error = ['upstream failed', 'primary failed']
    const server = Object.assign(new EventEmitter(), { id: 'worker', isPrimary: false,
        send: async () => ({ success: false, error }) })
    const db = initializeServerDB(server)
    const response = await db.send({ ...scope, method: 'object.read' })
    assert.equal(response.success, false)
    assert.strictEqual(response.error, error)
})

test('worker transport rejection appends its error to the original request errors', async () => {
    const server = Object.assign(new EventEmitter(), { id: 'worker', isPrimary: false,
        send: async () => { throw Error('primary unavailable') } })
    const db = initializeServerDB(server)
    const response = await db.send({ ...scope, method: 'object.read', error: ['earlier failure'] })
    assert.equal(response.success, false)
    assert.deepEqual(response.error, ['earlier failure', 'primary unavailable'])
})
