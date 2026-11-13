import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeServerDB } from '../src/server.js'
import { registerPersistenceDriver, persistenceDrivers } from '../src/persistence/driver.js'
import { removeMemoryPath } from '../src/memory.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const scope = { organization_id: '000000000000000000000001', storage: 'dev', database: 'app', array: 'keys' }
const id = n => n.toString(16).padStart(24, '0')
const server = () => Object.assign(new EventEmitter(), { id: 'recovery', isPrimary: true,
    send: async payload => payload, cluster: Object.assign(new EventEmitter(), { send() {} }) })
async function fixture(t, send) {
    const directory = await mkdtemp(join(tmpdir(), 'coc-hydration-'))
    registerPersistenceDriver('recovery-test', { send })
    let db = initializeServerDB(server(), { directory, externalPersistence: true, persistence: { workflow: 'must-not-run' },
        bootstrapPersistence: { name: 'recovery', provider: 'recovery-test' } })
    t.after(async () => { await db.close(); removeMemoryPath(directory); persistenceDrivers.delete('recovery-test'); await rm(directory, { recursive: true, force: true }) })
    return { directory, get db() { return db }, async restart() {
        await db.close()
        removeMemoryPath(directory)
        db = initializeServerDB(server(), { directory, externalPersistence: false })
        return db
    } }
}

test('provider reads hydrate complete local records, indexes and disk; an offline restart needs no provider', async t => {
    let reads = 0
    const f = await fixture(t, async request => {
        assert.equal(request.method, 'object.read')
        assert.equal(request.filter?.key, undefined, 'a projected response must not become the stored record')
        reads++
        return { success: true, object: [{ _id: id(1), name: 'default', default: true,
            methods: { object: { update: true } }, source: 'complete source', created: { on: new Date('2026-01-01T00:00:00.000Z') } }] }
    })
    const request = { ...scope, method: 'object.read', filter: { query: { default: true }, key: { name: 1 } } }
    const first = await f.db.send(request)
    assert.equal(first.success, true, first.error)
    assert.equal(first.object[0].name, 'default')
    assert.equal(first.object[0].source, undefined)
    await f.db.flush()
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
        import { createDB } from ${JSON.stringify(new URL('../src/index.js', import.meta.url).href)};
        const db = createDB({ directory: process.env.TEST_DB_DIRECTORY });
        const result = await db.send(JSON.parse(process.env.TEST_DB_READ));
        if (!result.success) throw Error(result.error);
        console.log(JSON.stringify(result.object));
    `], { env: { ...process.env,
        TEST_DB_DIRECTORY: f.directory,
        TEST_DB_READ: JSON.stringify({ ...scope, method: 'object.read', object: { _id: id(1) } }) } })
    assert.equal(JSON.parse(stdout)[0].source, 'complete source')
    const full = await f.db.send({ ...scope, method: 'object.read', object: { _id: id(1) } })
    assert.equal(full.object[0].source, 'complete source')
    assert.equal(full.object[0].methods.object.update, true)
    assert.equal(reads, 1)
    await f.restart()
    const restored = await f.db.send({ ...scope, method: 'object.read', filter: { query: { 'methods.object.update': true } } })
    assert.equal(restored.object[0].source, 'complete source')
    assert.equal(restored.object[0].created.on, '2026-01-01T00:00:00.000Z')
    assert.equal(reads, 1)
})

test('recovery never forwards creates or updates; the complete local tree survives restart', async t => {
    let providerCalls = 0
    const f = await fixture(t, async () => { providerCalls++; throw Error('Writes must remain local') })
    const created = await f.db.send({ ...scope, method: 'object.create', object: { _id: id(2), value: 1, keep: 'retained' } })
    assert.equal(created.success, true, created.error)
    const updated = await f.db.send({ ...scope, method: 'object.update', object: { _id: id(2), $inc: { value: 2 } } })
    assert.equal(updated.success, true, updated.error)
    await f.db.flush()
    await f.restart()
    const read = await f.db.send({ ...scope, method: 'object.read', filter: { query: { value: 3 } } })
    assert.equal(read.object[0]._id, id(2))
    assert.equal(read.object[0].keep, 'retained')
    assert.equal(providerCalls, 0)
})

test('a provider read error is surfaced without discarding locally saved records', async t => {
    const f = await fixture(t, async () => ({ success: false, error: ['provider offline'] }))
    const created = await f.db.send({ ...scope, method: 'object.create', object: { _id: id(3), value: 'local' } })
    assert.equal(created.success, true)
    const missing = await f.db.send({ ...scope, method: 'object.read', object: { _id: id(99) } })
    assert.equal(missing.success, false)
    assert.deepEqual(missing.error, ['provider offline'])
    await f.db.flush()
    await f.restart()
    const read = await f.db.send({ ...scope, method: 'object.read', object: { _id: id(3) } })
    assert.equal(read.object[0].value, 'local')
})

test('hydration keeps local changes and deletion markers and does not replay stale provider objects', async t => {
    const f = await fixture(t, async request => ({ success: true, object: request.method === 'object.read'
        ? [{ _id: id(4), value: 'stale' }, { _id: id(5), value: 'deleted' }] : [] }))
    await f.db.send({ ...scope, method: 'object.create', object: [{ _id: id(4), value: 'local' }, { _id: id(5), value: 'local' }] })
    await f.db.send({ ...scope, method: 'object.delete', object: { _id: id(5) } })
    const missed = await f.db.send({ ...scope, method: 'object.read', filter: { query: { value: 'stale' } } })
    assert.deepEqual(missed.object, [])
    const local = await f.db.send({ ...scope, method: 'object.read', object: { _id: id(4) } })
    assert.equal(local.object[0].value, 'local')
    const deleted = await f.db.send({ ...scope, method: 'object.read', object: { _id: id(5) } })
    assert.deepEqual(deleted.object, [])
})

test('recovery removes projection and source values and applies paging once after hydration', async t => {
    let reads = 0
    const f = await fixture(t, async request => {
        reads++
        assert.deepEqual(request.object, [])
        assert.equal(request.filter.key, undefined)
        assert.equal(request.filter.index, 0)
        assert.equal(request.filter.limit, 3)
        return { success: true, object: [0, 1, 2].map(rank => ({ _id: id(rank + 10), rank, source: 'whole' })) }
    })
    const result = await f.db.send({ ...scope, method: 'object.read', filter: { query: {}, index: 1, limit: 2,
        sort: [{ key: 'rank', direction: 'asc' }], key: { rank: 1 } } })
    assert.deepEqual(result.object.map(record => record.rank), [1, 2])
    assert.equal(result.object[0].source, undefined)
    const full = await f.db.send({ ...scope, method: 'object.read', object: { _id: id(10) } })
    assert.equal(full.object[0].source, 'whole')
    assert.equal(reads, 1)
    assert.throws(() => f.db.persistence.send({ ...scope, method: 'object.update' }), /writes are disabled/)
})
