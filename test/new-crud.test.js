import test from 'node:test'
import assert from 'node:assert/strict'
import { waitForIndex, waitForCondition } from './benchmarks/shared/wait-for-index.mjs'
import planQuery from '../src/tree/planner.js'
import { createTestTree, inspectTree } from '../test-support/tree.mjs'

const path = { organization_id: 'crud-org', storage: 'test', database: 'app', array: 'items' }

test('new CRUD performs full-query matching and mutations through the Tree visitor', async () => {
    const tree = await createTestTree({ size: 4, leafSize: 4 })
    const created = await tree.execute({
        ...path,
        method: 'object.create',
        object: Array.from({ length: 40 }, (_, rank) => ({ group: 'all', rank, active: true }))
    })
    assert.equal(created.success, true, created.error?.join('; '))
    assert.equal(created.object.length, 40)

    await waitForIndex(tree)
    const rootBranch = await tree.getPrimaryBranch({ ...path, method: 'object.read' })
    const plan = planQuery(rootBranch, { group: 'all', rank: { $gte: 10, $lt: 30 } })
    assert.equal(plan.kind, 'query')
    assert.equal(plan.expression.kind, 'and')
    assert.deepEqual(plan.expression.nodes.map(node => node.key), ['group', 'rank'])
    const andPlan = planQuery(rootBranch, { $and: [{ group: 'all' }, { rank: { $gte: 10, $lt: 30 } }] })
    assert.equal(andPlan.kind, 'query')
    assert.equal(andPlan.expression.nodes[0].kind, 'and')

    const updated = await tree.execute({
        ...path,
        method: 'object.update',
        filter: { query: { group: 'all', rank: { $gte: 10, $lt: 30 } }, limit: 0 },
        object: { $update: { $set: { active: false }, $inc: { rank: 100 } } }
    })
    assert.equal(updated.success, true, updated.error?.join('; '))
    assert.equal(updated.object.length, 20)

    await waitForIndex(tree)
    const selected = await tree.execute({
        ...path,
        method: 'object.read',
        filter: { query: { group: 'all', active: false, rank: { $gte: 110, $lt: 130 } }, limit: 0 }
    })
    assert.equal(selected.object.length, 20)

    const deleted = await tree.execute({
        ...path,
        method: 'object.delete',
        filter: { query: { group: 'all', active: true }, limit: 0 }
    })
    assert.equal(deleted.success, true, deleted.error?.join('; '))
    assert.equal(deleted.object.length, 20)

    await waitForIndex(tree)
    const remaining = await tree.execute({ ...path, method: 'object.read', filter: { query: { group: 'all' }, limit: 0 } })
    assert.equal(remaining.object.length, 20)
    assert.ok(remaining.object.every(leaf => leaf.active === false))
})

test('new CRUD handles UUID finds, route constraints, uniqueness, and unindexed fallbacks', async () => {
    const tree = await createTestTree({ size: 4, leafSize: 4 })
    const created = await tree.execute({ ...path, method: 'object.create', object: { uuid: 'stable-leaf', value: 'first' } })
    assert.equal(created.success, true, created.error?.join('; '))
    assert.equal((await tree.execute({ method: 'object.read', object: { uuid: 'stable-leaf' } })).object.length, 1)
    const supplied = await tree.execute({ ...path, method: 'object.create', object: { uuid: 'supplied-leaf', value: 'second' } })
    assert.equal(supplied.success, true, supplied.error?.join('; '))
    assert.equal((await tree.execute({ ...path, array: 'wrong', method: 'object.read', object: { uuid: 'stable-leaf' } })).object.length, 0)
    assert.equal((await tree.execute({ ...path, method: 'object.create', object: { uuid: 'stable-leaf' } })).success, false)

    await waitForIndex(tree)
    const unindexed = await tree.execute({ ...path, method: 'object.read', filter: { query: { value: { $includes: 'first' } }, limit: 0 } })
    assert.equal(unindexed.object.length, 1)
    assert.equal(planQuery(await tree.getPrimaryBranch({ ...path, method: 'object.read' }), { $or: [{ value: 'first' }, { value: 'second' }] }).expression.nodes[0].kind, 'or')
})

test('CRUD UUID create checks and read/update/delete bypass index planning', async () => {
    const tree = await createTestTree()
    const created = await tree.execute({ ...path, method: 'object.create', object: { uuid: 'direct-path-leaf', value: 1 } })
    assert.equal(created.success, true, created.error?.join('; '))

    const engine = inspectTree(tree.trees.get(created.object[0].parent))
    const getPrimaryBranch = engine.getPrimaryBranch
    engine.getPrimaryBranch = async () => { throw new Error('UUID operation must bypass index planning') }
    try {
        const read = await tree.execute({ ...path, method: 'object.read', object: { uuid: 'direct-path-leaf' } })
        assert.equal(read.success, true, read.error?.join('; '))
        assert.equal(read.object[0].value, 1)

        const updated = await tree.execute({ ...path, method: 'object.update', object: { uuid: 'direct-path-leaf', value: 2 } })
        assert.equal(updated.success, true, updated.error?.join('; '))
        assert.equal(updated.object[0].value, 2)

        const deleted = await tree.execute({ ...path, method: 'object.delete', object: { uuid: 'direct-path-leaf' } })
        assert.equal(deleted.success, true, deleted.error?.join('; '))
        assert.equal(deleted.object.length, 1)
    } finally { engine.getPrimaryBranch = getPrimaryBranch }
})

test('CRUD delegates timestamp reconciliation to Utils and indexes only the applied result', async () => {
    const tree = await createTestTree()
    const created = await tree.execute({
        ...path,
        method: 'object.create',
        object: { uuid: 'reconciled-leaf', updated: { on: 200, by: 'local' }, profile: { city: 'Lima' }, count: 4 }
    })
    assert.equal(created.success, true, created.error?.join('; '))
    const id = created.object[0]._id

    const stale = await tree.execute({
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

    await waitForIndex(tree)
    const indexed = await tree.execute({ ...path, method: 'object.read', filter: { query: { available: false }, limit: 0 } })
    assert.equal(indexed.object.length, 1)

    const newer = await tree.execute({
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
