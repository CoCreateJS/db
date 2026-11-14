import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createIndex from '../src/index/index.js'
import { createDB } from '../src/object/index.js'
import { createRecord, updateRecord, deleteRecord, readRecordById, findRecordByName } from '../src/records.js'
import { currentResolution, withResolution } from '../src/resolution.js'

async function fixture(t) {
    const directory = await mkdtemp(join(tmpdir(), 'coc-request-resolution-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const index = createIndex({ directory })
    const file = uuid => join(directory, 'records', `${uuid}.json`)
    const record = { _id: '000000000000000000000001', name: 'first', counter: 0 }
    await createRecord(index, 'db', 'items', file('1'.repeat(32)), record)
    const scans = []
    const scan = index.scan
    index.scan = async function* (...args) { scans.push(args[2]); yield* scan(...args) }
    return { index, file, record, scans }
}

test('one request reuses resolved name, ID, and file references without the shared memory cache', async t => {
    const { index, file, record, scans } = await fixture(t)
    let first
    await withResolution(async () => {
        first = await findRecordByName(index, 'db', 'items', file, 'first')
        assert.strictEqual(await readRecordById(index, 'db', 'items', file, record._id), first)
        await withResolution(async () => {
            assert.strictEqual(await findRecordByName(index, 'db', 'items', file, 'first'), first)
        })
        assert.deepEqual(scans, ['name'])
    })
    assert.equal(currentResolution(), undefined)
    await withResolution(async () => {
        const next = await readRecordById(index, 'db', 'items', file, record._id)
        assert.notStrictEqual(next, first, 'a new request performs its own resolution with memoryCache off')
        assert.deepEqual(next, first)
    })
    assert.deepEqual(scans, ['name', '_id'])
})

test('rename, delete, and recreation invalidate resolved aliases within the request', async t => {
    const { index, file, record } = await fixture(t)
    await withResolution(async () => {
        const current = await findRecordByName(index, 'db', 'items', file, 'first')
        await updateRecord(index, 'db', 'items', file('1'.repeat(32)), current, value => { value.name = 'renamed' })
        assert.strictEqual(await findRecordByName(index, 'db', 'items', file, 'renamed'), current)
        assert.equal(await findRecordByName(index, 'db', 'items', file, 'first'), undefined)
        await deleteRecord(index, 'db', 'items', file('1'.repeat(32)), current)
        assert.equal(await readRecordById(index, 'db', 'items', file, record._id), undefined)
        const replacement = { _id: record._id, name: 'renamed', counter: 9 }
        await createRecord(index, 'db', 'items', file('2'.repeat(32)), replacement)
        assert.strictEqual(await readRecordById(index, 'db', 'items', file, record._id), replacement)
    })
})

test('overlapping asynchronous requests and catalog scopes do not share resolution state', async t => {
    const { index, file, record } = await fixture(t)
    let release
    const gate = new Promise(resolve => { release = resolve })
    const first = withResolution(async () => {
        const context = currentResolution()
        const value = await readRecordById(index, 'db', 'items', file, record._id)
        await gate
        assert.strictEqual(currentResolution(), context)
        assert.strictEqual(await readRecordById(index, 'db', 'items', file, record._id), value)
        return value
    })
    const second = withResolution(async () => {
        const value = await readRecordById(index, 'db', 'items', file, record._id)
        assert.equal(await readRecordById(index, 'other', 'items', file, record._id), undefined)
        release()
        return value
    })
    const [a, b] = await Promise.all([first, second])
    assert.notStrictEqual(a, b)
})

test('queued indexing retains request references through later metadata changes', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'coc-resolved-queued-'))
    let originating, indexed
    const db = createDB({ directory, memoryOnly: true, nodeId: 'self', scheduleIndexing: () => {},
        partitionAdapter: { onLocalChange: (payload, apply) => {
            originating ??= currentResolution()
            return apply({ partitionId: payload.path, nodeId: 'self', operation: payload.operation === 'remove' ? 'remove' : 'add' })
        } },
        distributionAdapter: { onLocalChange: (payload, apply) => {
            originating ??= currentResolution()
            return apply(payload)
        } },
        onIndexed: () => { indexed = currentResolution() } })
    t.after(async () => { await db.close(); await rm(directory, { recursive: true, force: true }) })
    const scope = { database: 'app', array: 'items' }
    const created = await db.send({ ...scope, method: 'object.create', object: { counter: 1 } })
    assert.equal(created.success, true, created.error)
    assert.ok(originating)
    const updated = await db.send({ ...scope, method: 'array.update', config: { changed: true } })
    assert.equal(updated.success, true, updated.error)
    await db.flush()
    assert.strictEqual(indexed, originating)
    const array = await db.readLocalEntity({ type: 'array', databaseId: updated.array[0].databaseId, arrayId: updated.array[0]._id })
    assert.equal(array.config.changed, true)
    assert.equal(array.length, 1)
    assert.equal(currentResolution(), undefined)
})
