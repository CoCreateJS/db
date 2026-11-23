import { internal } from './internal.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import createDB from '../test-support/database.mjs'
import { createRootManager } from '../src/root.js'
import { crud } from '../src/crud/index.js'

const path = { organization_id: 'org', storage: 'main', database: 'app', array: 'items' }

test('UUID requests skip named root resolution, preserve explicit constraints', async () => {
    const db = await internal()
    const roots = db.roots
    const send = db.send
    const created = await send({ ...path, method: 'object.create', object: [{ uuid: 'a', price: 1 }, { uuid: 'b', price: 2 }] })
    assert.equal(created.success, true, created.error?.join('; '))
    const original = roots.resolve
    let calls = 0
    roots.resolve = (...args) => { calls++; return original(...args) }
    assert.equal((await send({ method: 'object.read', object: [{ uuid: 'a' }, { uuid: 'b' }] })).object.length, 2)
    assert.equal((await send({ ...path, array: 'wrong', method: 'object.read', object: { uuid: 'a' } })).object.length, 0)
    assert.equal((await send({ organization_id: 'other', method: 'object.read', object: { uuid: 'a' } })).object.length, 0)
    assert.equal((await send({ method: 'array.read', array: { uuid: 'a' } })).array.length, 0)
    assert.equal((await send({ method: 'object.update', object: { uuid: 'a', price: 5 } })).success, true)
    assert.equal(calls, 0)
    assert.equal((await send({ ...path, method: 'object.read', object: { uuid: 'a' }, filter: { query: { price: 2 } } })).object.length, 2)
    assert.equal(calls, 1)
    assert.equal((await send({ method: 'object.delete', object: { uuid: 'a' } })).object.length, 1)
    assert.equal((await send({ method: 'object.read', object: { uuid: 'a' } })).object.length, 0)
    assert.equal(calls, 1)
})

test('named identities, upsert, empty requests and configuration changes', async () => {
    const db = await internal()
    const send = request => db.send(request)
    assert.equal((await send({ method: 'object.read' })).object.length, 0)
    assert.equal(db.leaves.size, 0)
    assert.equal((await send({ method: 'object.update', object: { price: 1 } })).success, false)
    assert.equal(db.leaves.size, 0)
    const result = await send({ ...path, method: 'object.update', upsert: true, object: { uuid: 'new', price: 4 } })
    assert.equal(result.success, true, result.error?.join('; '))
    const array = await db.leaves.get(result.object[0].parent)
    assert.equal((await send({ method: 'array.read', array: { uuid: array.uuid } })).array[0], array)
    assert.equal((await send({ ...path, method: 'object.read', object: { _id: result.object[0]._id } })).object[0], result.object[0])
    await assert.rejects(db.config.setValue('roots.$organization_id.storage.database.array.object', undefined), /occupied/)
})

test('canonical root and parent metadata are immutable', async () => {
    const db = await createDB({isPrimary:true})
    const context = {organization_id:'org',storage:'store',database:'db',array:'items'}
    const result = await db.send({...context,method:'object.create',object:{uuid:'canonical',price:1}})
    assert.equal(result.success,true)
    await db.flushIndex()
    const leaf = result.object[0]
    assert.equal(leaf.root,'object')
    assert.equal((await db.send({method:'array.read',array:{uuid:leaf.parent}})).array[0].root,'array')
    assert.equal(Object.hasOwn(leaf,'rootType'),false)
    for (const key of ['root','parent']) {
        await assert.rejects(leaf.setValue(key,'wrong'))
        assert.equal((await db.send({...context,method:'object.update',object:{uuid:leaf.uuid,$update:{$set:{[key]:'wrong'}}}})).success,false)
    }
    assert.equal((await db.send({...context,method:'array.delete',array:{uuid:leaf.parent}})).success,false)
})
