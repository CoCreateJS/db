import test from 'node:test'
import assert from 'node:assert/strict'
import { createTree, createCRUD, planQuery, QueryPlanner } from '../src/index.js'

const path = { organization_id: 'crud-org', storage: 'test', database: 'app', array: 'items' }

test('new CRUD performs full-query matching and mutations through the Tree visitor', async () => {
    const tree = await createTree({ size: 4, leafSize: 4 })
    const crud = createCRUD(tree, new QueryPlanner())
    const created = await crud.send({
        ...path,
        method: 'object.create',
        object: Array.from({ length: 40 }, (_, rank) => ({ group: 'all', rank, active: true }))
    })
    assert.equal(created.success, true, created.error?.join('; '))
    assert.equal(created.object.length, 40)

    await tree.flushIndex()
    const rootBranch = await tree.getPrimaryBranch({ ...path, method: 'object.read' })
    const plan = planQuery(rootBranch, { group: 'all', rank: { $gte: 10, $lt: 30 } })
    assert.equal(plan.strategy, 'index')
    assert.equal(plan.key, 'rank')
    assert.ok(plan.branches.length > 1)
    const andPlan = planQuery(rootBranch, { $and: [{ group: 'all' }, { rank: { $gte: 10, $lt: 30 } }] })
    assert.equal(andPlan.strategy, 'index')
    assert.equal(andPlan.key, 'rank')

    const updated = await crud.send({
        ...path,
        method: 'object.update',
        filter: { query: { group: 'all', rank: { $gte: 10, $lt: 30 } }, limit: 0 },
        object: { $update: { $set: { active: false }, $inc: { rank: 100 } } }
    })
    assert.equal(updated.success, true, updated.error?.join('; '))
    assert.equal(updated.object.length, 20)

    await tree.flushIndex()
    const selected = await crud.send({
        ...path,
        method: 'object.read',
        filter: { query: { group: 'all', active: false, rank: { $gte: 110, $lt: 130 } }, limit: 0 }
    })
    assert.equal(selected.object.length, 20)

    const deleted = await crud.send({
        ...path,
        method: 'object.delete',
        filter: { query: { group: 'all', active: true }, limit: 0 }
    })
    assert.equal(deleted.success, true, deleted.error?.join('; '))
    assert.equal(deleted.object.length, 20)

    await tree.flushIndex()
    const remaining = await crud.send({ ...path, method: 'object.read', filter: { query: { group: 'all' }, limit: 0 } })
    assert.equal(remaining.object.length, 20)
    assert.ok(remaining.object.every(leaf => leaf.active === false))
})

test('new CRUD handles UUID finds, route constraints, uniqueness, and unindexed fallbacks', async () => {
    const tree = await createTree({ size: 4, leafSize: 4 })
    const crud = createCRUD(tree, new QueryPlanner())
    const created = await crud.send({ ...path, method: 'object.create', object: { uuid: 'stable-leaf', value: 'first' } })
    assert.equal(created.success, true, created.error?.join('; '))
    assert.equal((await crud.send({ method: 'object.read', object: { uuid: 'stable-leaf' } })).object.length, 1)
    const supplied = await crud.send({ ...path, method: 'object.create', object: { uuid: 'supplied-leaf', value: 'second' } })
    assert.equal(supplied.success, true, supplied.error?.join('; '))
    assert.equal((await crud.send({ ...path, array: 'wrong', method: 'object.read', object: { uuid: 'stable-leaf' } })).object.length, 0)
    assert.equal((await crud.send({ ...path, method: 'object.create', object: { uuid: 'stable-leaf' } })).success, false)

    const unindexed = await crud.send({ ...path, method: 'object.read', filter: { query: { value: { $includes: 'first' } }, limit: 0 } })
    assert.equal(unindexed.object.length, 1)
    assert.equal(planQuery(await tree.getPrimaryBranch({ ...path, method: 'object.read' }), { $or: [{ value: 'first' }, { value: 'second' }] }).strategy, 'scan')
})

test('CRUD UUID create checks and read/update/delete bypass index planning', async () => {
    const tree = await createTree()
    const crud = createCRUD(tree, new QueryPlanner())
    const created = await crud.send({ ...path, method: 'object.create', object: { uuid: 'direct-path-leaf', value: 1 } })
    assert.equal(created.success, true, created.error?.join('; '))

    const getPrimaryBranch = tree.getPrimaryBranch
    tree.getPrimaryBranch = async () => { throw new Error('UUID operation must bypass index planning') }
    try {
        const read = await crud.send({ ...path, method: 'object.read', object: { uuid: 'direct-path-leaf' } })
        assert.equal(read.success, true, read.error?.join('; '))
        assert.equal(read.object[0].value, 1)

        const updated = await crud.send({ ...path, method: 'object.update', object: { uuid: 'direct-path-leaf', value: 2 } })
        assert.equal(updated.success, true, updated.error?.join('; '))
        assert.equal(updated.object[0].value, 2)

        const deleted = await crud.send({ ...path, method: 'object.delete', object: { uuid: 'direct-path-leaf' } })
        assert.equal(deleted.success, true, deleted.error?.join('; '))
        assert.equal(deleted.object.length, 1)
    } finally { tree.getPrimaryBranch = getPrimaryBranch }
})

test('CRUD delegates timestamp reconciliation to Utils and indexes only the applied result', async () => {
    const tree = await createTree()
    const crud = createCRUD(tree, new QueryPlanner())
    const created = await crud.send({
        ...path,
        method: 'object.create',
        object: { uuid: 'reconciled-leaf', updated: { on: 200, by: 'local' }, profile: { city: 'Lima' }, count: 4 }
    })
    assert.equal(created.success, true, created.error?.join('; '))
    const id = created.object[0]._id

    const stale = await crud.send({
        ...path,
        method: 'object.update',
        object: {
            uuid: 'reconciled-leaf',
            $update: {
                updated: { on: 100, by: 'peer' },
                profile: { city: 'Quito', name: 'Ana' },
                available: false,
                $inc: { count: 5 }
            }
        }
    })
    assert.equal(stale.success, true, stale.error?.join('; '))
    assert.deepEqual(stale.object[0].profile, { city: 'Lima', name: 'Ana' })
    assert.equal(stale.object[0].count, 4)
    assert.equal(stale.object[0].available, false)
    assert.deepEqual(stale.object[0].updated, { on: 200, by: 'local' })
    assert.deepEqual(stale.$update[0], {
        $set: { 'profile.name': 'Ana', available: false },
        'updated.on': 100,
        'updated.by': 'peer',
        uuid: 'reconciled-leaf',
        _id: id
    })

    await tree.flushIndex()
    const indexed = await crud.send({ ...path, method: 'object.read', filter: { query: { available: false }, limit: 0 } })
    assert.equal(indexed.object.length, 1)

    const newer = await crud.send({
        ...path,
        method: 'object.update',
        object: { uuid: 'reconciled-leaf', $update: { updated: { on: 300, by: 'newer' }, $inc: { count: 1 } } }
    })
    assert.equal(newer.success, true, newer.error?.join('; '))
    assert.equal(newer.object[0].count, 5)
    assert.deepEqual(newer.object[0].updated, { on: 300, by: 'newer' })
    assert.deepEqual(newer.$update[0], {
        updated: { on: 300, by: 'newer' },
        $inc: { count: 1 },
        uuid: 'reconciled-leaf',
        _id: id
    })
})
