import test from 'node:test'
import assert from 'node:assert/strict'
import createDB from '../src/index.js'

const scope = { organization_id: 'org', storage: 'main', database: 'app', array: 'items' }
test('update returns operators and independent complete resulting objects', async () => {
    const db = createDB({}, { persistence: { set() { throw Error('unexpected hook') }, delete() { throw Error('unexpected hook') } } })
    const send = (method, object) => db.send({ ...scope, method: `object.${method}`, object })
    const created = (await send('create', { uuid: 'a', quantity: 10, price: 4, tags: ['x'], obsolete: true })).object[0]
    const patch = { '$inc.quantity': 5, '$push.tags': 'y', '$unset.obsolete': true, price: 8 }
    const result = await send('update', { uuid: 'a', ...patch })
    assert.equal(result.success, true)
    assert.deepEqual(result.object, [{ uuid: 'a', _id: created._id, ...patch }])
    assert.deepEqual(result.updated[0], { uuid: 'a', _id: created._id, scope: 'object', parent: created.parent, quantity: 15, price: 8, tags: ['x', 'y'] })
    await send('update', { uuid: 'a', '$inc.quantity': 2, '$push.tags': 'z' })
    assert.equal(result.updated[0].quantity, 15)
    assert.deepEqual(result.updated[0].tags, ['x', 'y'])
    assert.equal((await send('read', { uuid: 'a' })).object[0].quantity, 17)
    assert.equal((await send('delete', { uuid: 'a' })).success, true)
})
test('batch update pairs patches and snapshots and excludes failed mutations', async () => {
    const db = createDB()
    const send = (method, object) => db.send({ ...scope, method: `object.${method}`, object })
    await send('create', [{ uuid: 'a', n: 1 }, { uuid: 'b', n: 2 }])
    const result = await send('update', [{ uuid: 'a', '$inc.n': 2 }, { uuid: 'b', '$inc.n': 3 }])
    assert.deepEqual(result.updated.map(x => x.n), [3, 5])
    assert.deepEqual(result.object.map(x => x.uuid), ['a', 'b'])
    const failed = await send('update', { uuid: 'a', '$inc.n': 'bad' })
    assert.equal(failed.success, false)
    assert.equal(failed.updated, undefined)
})
