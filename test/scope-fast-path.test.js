import { internal } from './internal.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import createDB from '../src/index.js'
import { createScopeManager } from '../src/scope.js'
import { crud } from '../src/crud/index.js'

const path = { organization_id: 'org', storage: 'main', database: 'app', array: 'items' }

test('UUID requests skip named scope resolution, preserve explicit constraints', async () => {
    const db = internal()
    const scopes = db.scopes
    const send = db.send
    const created = await send({ ...path, method: 'object.create', object: [{ uuid: 'a', price: 1 }, { uuid: 'b', price: 2 }] })
    assert.equal(created.success, true, created.error?.join('; '))
    const original = scopes.resolve
    let calls = 0
    scopes.resolve = (...args) => { calls++; return original(...args) }
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
    const db = internal()
    const send = request => db.send(request)
    assert.equal((await send({ method: 'object.read' })).object.length, 0)
    assert.equal(db.artifacts.size, 0)
    assert.equal((await send({ method: 'object.update', object: { price: 1 } })).success, false)
    assert.equal(db.artifacts.size, 0)
    const result = await send({ ...path, method: 'object.update', upsert: true, object: { uuid: 'new', price: 4 } })
    assert.equal(result.success, true, result.error?.join('; '))
    const array = db.artifacts.get(result.object[0].parent)
    assert.equal((await send({ method: 'array.read', array: { uuid: array.uuid } })).array[0], array)
    assert.equal((await send({ ...path, method: 'object.read', object: { _id: result.object[0]._id } })).object[0], result.object[0])
    assert.throws(() => db.config.setValue('scopes.$organization_id.storage.database.array.object', undefined), /occupied/)
})

test('canonical scope and parent metadata are immutable', async () => {
    const db = createDB({isPrimary:true})
    const context = {organization_id:'org',storage:'store',database:'db',array:'items'}
    const result = await db.send({...context,method:'object.create',object:{uuid:'canonical',price:1}})
    assert.equal(result.success,true)
    const artifact = result.object[0]
    assert.equal(artifact.scope,'object')
    assert.equal((await db.send({method:'array.read',array:{uuid:artifact.parent}})).array[0].scope,'array')
    assert.equal(Object.hasOwn(artifact,'scopeType'),false)
    for (const key of ['scope','parent']) {
        assert.throws(() => artifact.setValue(key,'wrong'))
        assert.equal((await db.send({...context,method:'object.update',object:{uuid:artifact.uuid,$update:{$set:{[key]:'wrong'}}}})).success,false)
    }
    assert.equal((await db.send({...context,method:'array.delete',array:{uuid:artifact.parent}})).success,false)
})
