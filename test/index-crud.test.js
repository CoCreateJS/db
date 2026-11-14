import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDB } from '../src/index.js'
import { createDB as createEngine } from '../src/object/index.js'

for (const [label, create] of [['scoped DB', createDB], ['engine', createEngine]]) {
    test(`${label} routes index CRUD to the existing entry behavior`, async t => {
        const directory = await mkdtemp(join(tmpdir(), 'coc-index-crud-'))
        const db = create({ directory })
        t.after(async () => { await db.close(); await rm(directory, { recursive: true, force: true }) })

        const scope = { organization_id: '000000000000000000000001', storage: 'production' }
        const send = (method, index, extra = {}) => db.send({
            ...scope, database: 'app', array: 'items', method: `index.${method}`, index, ...extra
        })
        const entry = { key: 'score', value: 1, objectId: '000000000000000000000002' }
        assert.equal((await send('create', entry)).success, true)
        const first = await send('read', { key: 'score' })
        assert.equal(first.success, true)
        assert.deepEqual(first.index[0].indexes.number.entries, [[1, entry.objectId]])

        // Update retains the previous insertion semantics; replacement is deferred.
        assert.equal((await send('update', [{ ...entry, value: 2 }])).success, true)
        assert.equal((await send('read', { key: 'score' })).index[0].indexes.number.length, 2)
        assert.deepEqual((await send('delete', entry)).index, [entry])
        const result = await send('read', { key: 'score' })
        assert.deepEqual(result.index[0].indexes.number.entries, [[2, entry.objectId]])

        for (const method of ['create', 'read', 'update', 'delete']) assert.equal(typeof db.index[method], 'function')
        for (const method of ['get', 'set', 'remove']) assert.equal(db.index[method], undefined)
        const args = label === 'scoped DB' ? [scope] : []
        assert.deepEqual(await db.index.read(...args, 'app', 'items', 'score'), result.index[0])

        const failed = await send('invalid', entry, { error: ['Earlier error'] })
        assert.equal(failed.success, false)
        assert.deepEqual(failed.error, ['Earlier error', 'Unsupported CRUD method: index.invalid'])
        if (label === 'scoped DB') {
            const other = await db.send({ ...scope, storage: 'other', database: 'app', array: 'items', method: 'index.read', index: { key: 'score' } })
            assert.deepEqual(other.index, [])
        }
    })
}
