import test from 'node:test'
import assert from 'node:assert/strict'
import DB, { Tree } from '@cocreate/db'
import * as api from '@cocreate/db'
import { Organization } from '../src/organization.js'
import { treeContexts } from '../src/tree/internal.js'
import { databaseRuntimes } from '../src/runtime.js'
import { waitForIdle } from './benchmarks/shared/wait-for-index.mjs'
import { MemoryDisk } from '../test-support/memory-disk.mjs'

const payload = { organization_id: 'public-org', storage: 'test', database: 'app', array: 'items' }

test('DB.init is the only DB constructor and returns the thin public interface', async () => {
    assert.equal(typeof DB, 'object')
    assert.deepEqual(Object.keys(DB), ['init'])
    assert.deepEqual(Object.keys(api).sort(), ['Tree', 'default'])
    const db = await DB.init({}, { prompt: false })
    try {
        assert.deepEqual(Object.keys(db).sort(), ['config', 'organizations', 'send'])
        assert.deepEqual(Object.keys(db.organizations), ['get'])
        const tree = await db.organizations.get(payload.organization_id)
        assert.ok(tree instanceof Organization)
        assert.equal(typeof tree.harvest, 'function')
        assert.equal('prune' in tree, false)
        assert.equal(db.config.memory.harvestAt, 75)
        assert.equal('pruneAt' in db.config.memory, false)
        assert.equal(tree, await db.organizations.get(payload.organization_id))
        const created = await db.send({ ...payload, method: 'object.create', object: { value: 1 } })
        assert.equal(created.success, true)
        const primary = await databaseRuntimes.get(db).trees.get(payload.organization_id, created.object[0].parent)
        assert.ok(primary instanceof Tree)
        assert.equal((await primary.leaves.get(created.object[0].uuid)).value, 1)
        await waitForIdle(databaseRuntimes.get(db))
        assert.equal(databaseRuntimes.get(db).trees.organizations.get(payload.organization_id).get(primary.uuid), primary)
    } finally { await databaseRuntimes.get(db).close() }
})

test('each primary Tree owns replaceable stateless execute and planner functions', async () => {
    const db = await DB.init({}, { prompt: false })
    try {
        const created = await db.send({ ...payload, method: 'object.create', object: { value: 'planned' } })
        assert.equal(created.success, true)
        const organization = await db.organizations.get(payload.organization_id)
        const tree = await databaseRuntimes.get(db).trees.get(payload.organization_id, created.object[0].parent)
        const neighbor = await db.send({ ...payload, array: 'neighbor', method: 'object.create', object: { value: 'other' } })
        const other = await databaseRuntimes.get(db).trees.get(payload.organization_id, neighbor.object[0].parent)
        assert.notEqual(tree, other)
        assert.equal(tree.execute, other.execute)
        assert.equal(tree.planner, other.planner)
        for (const key of ['getLeaf', 'createLeaf', 'updateLeaf', 'removeLeaf', 'getPrimaryBranch', 'getLeaves', 'range', 'branches', 'pendingIndexCount', 'roots'])
            assert.equal(key in tree, false, `${key} is internal or belongs to Organization`)
        const execute = tree.execute
        let calls = 0
        tree.execute = async function(request) { calls++; return execute.call(this, request) }
        await waitForIdle(databaseRuntimes.get(db))
        const planner = tree.planner
        let planned = 0
        tree.planner = (branch, query, filter) => { planned++; return planner(branch, query, filter) }
        const read = await db.send({ ...payload, method: 'object.read', filter: { query: { value: 'planned' } } })
        assert.equal(read.success, true, read.error?.join('; '))
        assert.equal(read.object[0].uuid, created.object[0].uuid)
        assert.equal(planned, 1)
        assert.equal(calls, 1)
    } finally { await databaseRuntimes.get(db).close() }
})

test('standalone Tree executes CRUD, exposes configuration flags, and delegates persistence', async () => {
    const tree = new Tree()
    tree.disk = new MemoryDisk()
    let persisted = 0
    tree.persistence = { queue: {},
        async execute(request) { return request.operation === 'read' ? undefined : request },
        async persist() { persisted++; return { success: true } }
    }
    await tree.init({ uuid: 'standalone', roots: { object: {} }, size: 8, leafSize: 4, diskFirst: true })
    try {
        assert.equal(tree.config.size, 8)
        assert.equal(tree.config.leafSize, 4)
        assert.equal(tree.config.diskFirst, true)
        tree.setDiskFirst(false)
        assert.equal(tree.config.diskFirst, false)
        const created = await tree.execute({ method: 'object.create', object: { value: 1 } })
        const uuid = created.object[0].uuid
        assert.equal((await tree.execute({ method: 'object.update', object: { uuid, '$inc.value': 1 } })).object[0].value, 2)
        assert.deepEqual(await tree.persist(), { success: true })
        assert.equal(persisted, 1)
        assert.equal((await tree.execute({ method: 'object.delete', object: { uuid } })).success, true)
        assert.equal((await tree.execute({ method: 'object.read', object: { uuid } })).object.length, 0)
    } finally { await tree.close() }
})

test('each worker context owns an independent local DB through the thin API', async () => {
    const instances = await Promise.all(Array.from({ length: 3 }, () => DB.init({
        isPrimary: false, isWorker: true,
        send() { throw Error('DB must not forward') }
    }, { prompt: false })))
    try {
        const organizations = []
        for (const [value, db] of instances.entries()) {
            assert.deepEqual(Object.keys(db).sort(), ['config', 'organizations', 'send'])
            const created = await db.send({ ...payload, method: 'object.create', object: { uuid: 'same-id', value } })
            assert.equal(created.success, true)
            const organization = await db.organizations.get(payload.organization_id)
            organizations.push(organization)
            const tree = await databaseRuntimes.get(db).trees.get(payload.organization_id, created.object[0].parent)
            assert.ok(tree instanceof Tree)
            assert.equal((await tree.leaves.get('same-id')).value, value)
        }
        assert.equal(new Set(organizations).size, 3)
        await databaseRuntimes.get(instances[0]).close()
        for (const value of [1, 2]) {
            const read = await instances[value].send({ ...payload, method: 'object.read', object: { uuid: 'same-id' } })
            assert.equal(read.object[0].value, value)
        }
    } finally { await Promise.all(instances.map(db => databaseRuntimes.get(db).close())) }
})

test('concurrent organization lookups reuse one router and closing clears its resident Trees', async () => {
    const db = await DB.init({}, { prompt: false })
    try {
        const trees = await Promise.all(Array.from({ length: 32 }, () => db.organizations.get('same-org')))
        assert.equal(new Set(trees).size, 1)
        await trees[0].close()
        assert.equal(databaseRuntimes.get(db).trees.organizations.has('same-org'), false)
    } finally { await databaseRuntimes.get(db).close() }
})

test('Tree read ports and standalone close work as detached function references', async () => {
    const tree = new Tree()
    await tree.init({ uuid: 'standalone', roots: { object: {} } })
    const close = tree.close
    try {
        assert.throws(() => { tree.disk = {} }, /must expose execute/)
        assert.throws(() => { tree.disk = { async execute() {} } }, /queue/)
        assert.throws(() => { tree.persistence = { async execute() {} } }, /queue/)
        assert.throws(() => { tree.persistence = { queue: {},} }, /must expose execute/)
        assert.equal((await tree.execute({ method: 'object.create', object: [null] })).success, false)
        const created = await tree.execute({ method: 'object.create', object: { value: 'direct' } })
        const get = tree.leaves.get
        const has = tree.leaves.has
        assert.equal((await get(created.object[0].uuid)).value, 'direct')
        assert.equal(await has(created.object[0].uuid), true)
        assert.deepEqual(tree.config.roots, { object: {} })
    } finally { await close() }
})
