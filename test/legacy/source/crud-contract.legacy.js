import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDB } from '../src/index.js'
import { filterLimit, normalizeEntities } from '../src/crud.js'
import { removeMemoryPath } from '../src/memory.js'

const organization_id = '000000000000000000000001'
const scope = { organization_id, storage: 'primary', database: 'app', array: 'items' }

test('CoCreateDB CRUD payload and filter conventions', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'coc-crud-contract-'))
    const db = createDB({ directory, memoryOnly: true })
    t.after(async () => {
        await db.close()
        removeMemoryPath(directory)
        await rm(directory, { recursive: true, force: true })
    })
    const send = (method, extra = {}) => db.send({ ...scope, method, ...extra })

    assert.deepEqual(normalizeEntities(undefined, 'object'), [])
    assert.throws(() => normalizeEntities('uuid1', 'object'), /object or an array of objects/)
    assert.throws(() => normalizeEntities(['uuid1'], 'object'), /object or an array of objects/)
    assert.equal(filterLimit({}), 50)
    assert.equal(filterLimit({ limit: 0 }), 0)
    assert.throws(() => filterLimit({ limit: -1 }), /non-negative integer/)

    const scopeCreated = await db.send({ organization_id, method: 'storage.create', storage: { name: 'primary' } })
    assert.equal(scopeCreated.success, true, scopeCreated.error?.join('; '))
    const storageUuid = scopeCreated.storage[0].uuid
    assert.equal((await db.send({ organization_id, method: 'storage.read', storage: { uuid: storageUuid } })).storage[0].name, 'primary')
    assert.equal((await db.send({ organization_id, method: 'storage.create', storage: 'primary' })).success, false)
    const databaseCreated = await db.send({ organization_id, storage: 'primary', method: 'database.create', database: { name: 'app' } })
    assert.equal(databaseCreated.success, true, databaseCreated.error?.join('; '))
    const databaseUuid = databaseCreated.database[0].uuid
    assert.equal((await db.send({ organization_id, storage: 'primary', method: 'database.read', database: { uuid: databaseUuid } })).database[0].name, 'app')
    const renamedDatabase = await db.send({ organization_id, storage: 'primary', method: 'database.update', database: { uuid: databaseUuid, newName: 'application' } })
    assert.equal(renamedDatabase.success, true, renamedDatabase.error?.join('; '))
    scope.database = 'application'
    const arrayCreated = await db.send({ organization_id, storage: 'primary', database: 'application', method: 'array.create', array: { name: 'items' } })
    assert.equal(arrayCreated.success, true, arrayCreated.error?.join('; '))
    const arrayUuid = arrayCreated.array[0].uuid
    assert.equal((await db.send({ organization_id, storage: 'primary', database: 'application', method: 'array.read', array: { uuid: arrayUuid } })).array[0].name, 'items')
    assert.equal((await db.send({ organization_id, storage: 'primary', method: 'database.create', database: { name: 'application' } })).success, false)
    assert.equal((await db.send({ organization_id, storage: 'primary', database: 'application', method: 'array.create', array: { name: 'items' } })).success, false)

    const docs = Array.from({ length: 55 }, (_, rank) => ({ rank, group: rank < 3 ? 'match' : 'other' }))
    docs[0]._id = 'id1'
    const created = await send('object.create', { object: docs })
    assert.equal(created.success, true, created.error?.join('; '))
    assert.ok(docs.every(doc => /^[a-f0-9]{32}$/.test(doc.uuid)))
    assert.ok(docs.every(doc => typeof doc._id === 'string' && doc._id.length > 0))
    assert.equal((await send('object.read', { object: { _id: 'id1' } })).object[0].uuid, docs[0].uuid)
    assert.equal((await send('object.create', { object: { _id: 'id1' } })).success, false)
    assert.equal((await send('object.read', { filter: {} })).object.length, 50)
    assert.equal((await send('object.read', { filter: { limit: 0 } })).object.length, 55)
    assert.equal((await send('object.read', { filter: { limit: -1 } })).success, false)

    const selected = await send('object.read', {
        object: { uuid: docs[54].uuid },
        filter: { query: { group: 'match' } }
    })
    assert.equal(selected.success, true, selected.error?.join('; '))
    assert.deepEqual(selected.object.map(doc => doc.uuid), [docs[54].uuid, docs[0].uuid, docs[1].uuid, docs[2].uuid])

    const explicitByBoth = await send('object.read', { object: { uuid: docs[0].uuid, _id: docs[1]._id } })
    assert.equal(explicitByBoth.success, false)
    assert.match(explicitByBoth.error.join(' '), /resolve to different objects/)

    const updated = await send('object.update', {
        object: { uuid: docs[54].uuid, $update: { $inc: { rank: 10 } } },
        filter: { query: { group: 'match' }, limit: 1 }
    })
    assert.equal(updated.success, true, updated.error?.join('; '))
    assert.equal(docs[54].rank, 64, 'explicit selection is independent of the filter')
    assert.equal(docs[0].rank, 10, 'the filter independently selects one more document')
    const immutable = await send('object.update', { object: { uuid: docs[0].uuid, $update: { $set: { uuid: '00000000000000000000000000000000' } } } })
    assert.equal(immutable.success, false)
    assert.equal(docs[0].uuid, created.object[0].uuid)

    const deleted = await send('object.delete', {
        object: { uuid: docs[54].uuid },
        filter: { query: { group: 'match' }, limit: 1 }
    })
    assert.equal(deleted.success, true, deleted.error?.join('; '))
    assert.equal(deleted.object.length, 2)
    assert.equal((await send('object.read', { object: { uuid: docs[54].uuid } })).object.length, 0)

    const invalid = await send('object.create', { object: ['not-an-object'] })
    assert.equal(invalid.success, false)
    const empty = await send('object.create', { object: {} })
    assert.equal(empty.success, true, empty.error?.join('; '))
    assert.ok(empty.object[0].uuid)
})
