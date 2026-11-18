import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDB } from '../src/index.js'
import { removeMemoryPath } from '../src/memory.js'
import { deleteOrganization } from '../src/organization.js'

test('scoped CRUD lifecycle indexes nested paths and keeps UUID selection direct', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'coc-lifecycle-'))
    const organization_id = '000000000000000000000031'
    const scope = { organization_id, storage: 'primary', database: 'app', array: 'items' }
    const db = createDB({ directory, memoryOnly: true, nodeId: 'lifecycle' })
    t.after(async () => {
        await db.close()
        removeMemoryPath(directory)
        await rm(directory, { recursive: true, force: true })
    })
    const send = (method, extra = {}) => db.send({ ...scope, method, ...extra })

    for (const request of [
        { method: 'storage.create', storage: { name: scope.storage } },
        { method: 'database.create', database: { name: scope.database } },
        { method: 'array.create', array: { name: scope.array } }
    ]) {
        const response = await send(request.method, request)
        assert.equal(response.success, true, response.error?.join('; '))
    }

    const documents = [
        { _id: 'item-a', group: 'red', profile: { city: 'Lima' }, scores: [3, 8], nested: [{ code: 'x' }] },
        { _id: 'item-b', group: 'blue', profile: { city: 'Paris' }, scores: [4, 9], nested: [{ code: 'y' }] },
        { _id: 'item-c', group: 'red', profile: { city: 'Lima' }, scores: [5], nested: [{ code: 'z' }] }
    ]
    const created = await send('object.create', { object: documents })
    assert.equal(created.success, true, created.error?.join('; '))
    assert.deepEqual(created.object.map(item => item.uuid), documents.map(item => item.uuid))
    await db.flush()
    assert.equal((await send('array.read', { array: { name: scope.array } })).array[0].length, documents.length)
    assert.equal((await send('database.read', { database: { name: scope.database } })).database[0].objectLength, documents.length)

    const byUuid = await send('object.read', { object: { uuid: documents[1].uuid } })
    assert.deepEqual(byUuid.object.map(item => item._id), ['item-b'])
    const nested = await send('object.read', { filter: { query: { 'profile.city': 'Lima' }, limit: 0 } })
    assert.deepEqual(nested.object.map(item => item._id).sort(), ['item-a', 'item-c'])
    const limitedRange = await send('object.read', { filter: { query: { 'scores[0]': { $gte: 3 } }, limit: 1 } })
    assert.deepEqual(limitedRange.object.map(item => item._id), ['item-a'])
    const positional = await send('object.read', { filter: { query: { 'scores[1]': 9 }, limit: 0 } })
    assert.deepEqual(positional.object.map(item => item._id), ['item-b'])

    const updated = await send('object.update', { object: { uuid: documents[0].uuid,
        $update: { $inc: { 'scores[0]': 2 }, $set: { 'profile.city': 'Rome' }, $unset: { group: true } } } })
    assert.equal(updated.success, true, updated.error?.join('; '))
    assert.equal(documents[0].scores[0], 5)
    assert.equal(documents[0].profile.city, 'Rome')
    assert.equal('group' in documents[0], false)
    assert.equal((await send('object.read', { filter: { query: { 'profile.city': 'Rome' } } })).object[0].uuid, documents[0].uuid)

    const deleted = await send('object.delete', { filter: { query: { group: 'red' }, limit: 0 } })
    assert.equal(deleted.success, true, deleted.error?.join('; '))
    assert.deepEqual(deleted.object.map(item => item._id), ['item-c'])
    await db.flush()
    assert.equal((await send('array.read', { array: { name: scope.array } })).array[0].length, 2)
    assert.equal((await send('database.read', { database: { name: scope.database } })).database[0].objectLength, 2)
    assert.deepEqual((await send('object.read', { filter: { query: { group: 'red' }, limit: 0 } })).object, [])
    assert.equal((await send('object.read', { object: { uuid: documents[0].uuid } })).object.length, 1)
    await db.flush()
})

test('disk persistence reopens organization scopes and UUID-addressed artifacts', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'coc-lifecycle-reopen-'))
    const organization_id = '000000000000000000000032'
    const scope = { organization_id, storage: 'primary', database: 'app', array: 'items' }
    let db = createDB({ directory })
    const send = (method, extra = {}) => db.send({ ...scope, method, ...extra })
    t.after(async () => {
        await db.close()
        deleteOrganization(organization_id)
        removeMemoryPath(directory)
        await rm(directory, { recursive: true, force: true })
    })
    for (const request of [
        { method: 'storage.create', storage: { name: scope.storage } },
        { method: 'database.create', database: { name: scope.database } },
        { method: 'array.create', array: { name: scope.array } }
    ]) assert.equal((await send(request.method, request)).success, true)
    const created = await send('object.create', { object: { label: 'survives restart', nested: { rank: 17 } } })
    assert.equal(created.success, true, created.error?.join('; '))
    await db.flush()
    await db.close()
    deleteOrganization(organization_id)
    removeMemoryPath(directory)

    db = createDB({ directory })
    const restored = await db.send({ ...scope, method: 'object.read', object: { uuid: created.object[0].uuid } })
    assert.equal(restored.success, true, restored.error?.join('; '))
    assert.equal(restored.object[0].label, 'survives restart')
    assert.deepEqual(restored.object[0].nested, { rank: 17 })
})
