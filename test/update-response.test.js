import test from 'node:test'
import assert from 'node:assert/strict'
import createDB from '../src/index.js'

const root = { organization_id: 'org', storage: 'main', database: 'app', array: 'items' }
test('update returns operators and independent complete resulting objects', async () => {
    const db = createDB({}, { persistence: { set() { throw Error('unexpected hook') }, delete() { throw Error('unexpected hook') } } })
    const send = (method, object) => db.send({ ...root, method: `object.${method}`, object })
    const created = (await send('create', { uuid: 'a', quantity: 10, price: 4, tags: ['x'], obsolete: true })).object[0]
    const patch = { '$inc.quantity': 5, '$push.tags': 'y', '$unset.obsolete': true, price: 8, 'updated.on': 200, 'updated.by': 'user1' }
    const result = await send('update', { uuid: 'a', ...patch })
    assert.equal(result.success, true)
    assert.deepEqual(result.$update, [{ uuid: 'a', _id: created._id, ...patch }])
    assert.deepEqual(result.object[0], { uuid: 'a', _id: created._id, root: 'object', parent: created.parent, quantity: 15, price: 8, tags: ['x', 'y'], updated: { on: 200, by: 'user1' } })
    await send('update', { uuid: 'a', '$inc.quantity': 2, '$push.tags': 'z' })
    assert.equal(result.object[0].quantity, 15)
    assert.deepEqual(result.object[0].tags, ['x', 'y'])
    assert.equal((await send('read', { uuid: 'a' })).object[0].quantity, 17)
    assert.equal((await send('delete', { uuid: 'a' })).success, true)
})
test('batch update pairs patches and snapshots and excludes failed mutations', async () => {
    const db = createDB()
    const send = (method, object) => db.send({ ...root, method: `object.${method}`, object })
    await send('create', [{ uuid: 'a', n: 1 }, { uuid: 'b', n: 2 }])
    const result = await send('update', [{ uuid: 'a', '$inc.n': 2 }, { uuid: 'b', '$inc.n': 3 }])
    assert.deepEqual(result.object.map(x => x.n), [3, 5])
    assert.deepEqual(result.$update.map(x => x.uuid), ['a', 'b'])
    const failed = await send('update', { uuid: 'a', '$inc.n': 'bad' })
    assert.equal(failed.success, false)
    assert.deepEqual(failed.$update, [])
})

test('older updates fill missing paths without overwriting newer values or audit', async () => {
    const db = createDB()
    const send = (method, object, extra = {}) => db.send({ ...root, method: `object.${method}`, object, ...extra })
    await send('create', { uuid: 'a', price: 150, quantity: 5, profile: { name: 'new' }, tags: ['new'], updated: { on: 200, by: 'new' } })
    const result = await send('update', { uuid: 'a', price: 100, profile: { name: 'old', city: 'NYC' }, description: 'old', '$inc.quantity': 3, '$unset.price': true, '$push.tags': 'old', 'updated.on': 100, 'updated.by': 'old' })
    assert.equal(result.success, true)
    assert.equal(result.object[0].price, 150)
    assert.equal(result.object[0].quantity, 5)
    assert.deepEqual(result.object[0].tags, ['new'])
    assert.deepEqual(result.object[0].profile, { name: 'new', city: 'NYC' })
    assert.deepEqual(result.object[0].updated, { on: 200, by: 'new' })
    assert.equal(result.$update[0]['profile.city'], 'NYC')
    assert.equal(result.$update[0]['updated.on'], 100)
    assert.equal(Object.hasOwn(result.$update[0], 'price'), false)
    const query = await send('read', [], { filter: { query: { 'profile.city': 'NYC' } } })
    assert.equal(query.object.length, 1)
    const repeat = await send('update', [], { $update: result.$update })
    assert.deepEqual(repeat.$update, [])
})

test('replay uses mutation rather than object snapshot; newer and undated updates apply', async () => {
    const db = createDB()
    const send = (method, object, extra = {}) => db.send({ ...root, method: `object.${method}`, object, ...extra })
    await send('create', { uuid: 'a', n: 1, price: 200 })
    const result = await send('update', { uuid: 'a', n: 99, price: 1 }, { $update: [{ uuid: 'a', '$inc.n': 2, 'updated.on': 200 }] })
    assert.equal(result.success, true)
    assert.equal(result.object[0].n, 3)
    assert.equal(result.object[0].price, 200)
    assert.deepEqual((await send('update', [], { $update: result.$update })).$update, [])
    assert.equal((await send('update', { uuid: 'a', n: 9, 'updated.on': 300 })).object[0].n, 9)
    assert.equal((await send('update', { uuid: 'a', n: 10 })).object[0].n, 10)
    assert.equal((await send('update', { uuid: 'a', n: 0, 'updated.on': 'invalid' })).success, false)
})
