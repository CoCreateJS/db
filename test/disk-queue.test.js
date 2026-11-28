import test from 'node:test'
import assert from 'node:assert/strict'
import { createRuntime } from '../src/runtime.js'
import { treeContexts } from '../src/tree/internal.js'
import { MemoryDisk, leafPath } from '../test-support/memory-disk.mjs'
import { createStorage } from '../../disk/src/core.js'
import { waitForIndex, waitForIdle, waitForCondition } from './benchmarks/shared/wait-for-index.mjs'

const scope = { organization_id: 'queue-org', storage: 'main', database: 'app', array: 'items' }
const create = (db, object) => db.send({ ...scope, method: 'object.create', object })
const read = (db, query) => db.send({ ...scope, method: 'object.read', filter: { query, limit: 0 } })
const gate = () => {
    let release, enter
    return { blocked: new Promise(resolve => { release = resolve }), started: new Promise(resolve => { enter = resolve }),
        release: () => release(), enter: () => enter() }
}

test('blocked disk does not block indexing/searchability, and queue groups leaf/branch work under its primary UUID', async () => {
    const disk = new MemoryDisk(), hold = gate()
    const execute = disk.access.bind(disk)
    disk.access = async request => {
        if (request.operation === 'write' && request.path.includes('/leaves/')) { hold.enter(); await hold.blocked }
        return await execute(request)
    }
    const db = await createRuntime({}, { disk, size: 8 })
    try {
        const response = await create(db, Array.from({ length: 1100 }, (_, score) => ({ score })))
        assert.equal(response.success, true, response.error?.join('; '))
        await hold.started
        await waitForIndex(db, { timeoutMs: 3000 })
        assert.equal(db.pendingIndexCount, 0)
        assert.ok(db.pendingDiskCount > 0)
        const indexed = await read(db, { score: { $gte: 0 } })
        assert.equal(indexed.object.length, 1100)
        const primary = response.object[0].parent
        const tree = await db.trees.get(scope.organization_id, primary)
        const context = treeContexts.get(tree)
        const snapshot = JSON.parse(JSON.stringify(disk.queue))
        assert.ok(Object.hasOwn(snapshot, primary))
        assert.equal(Object.keys(snapshot[primary].leaves).length, 1100)
        assert.ok(Object.keys(snapshot[primary].branches).length > 0)
        const operation = snapshot[primary].leaves[response.object[0].uuid]
        assert.equal(operation.operation, 'write')
        assert.equal(JSON.parse(operation.data).object.score, 0)
        const org = await db.organizations.get(scope.organization_id)
        assert.deepEqual(await org.harvest({ uuid: primary }), { count: 0 })
        hold.release()
        await waitForIdle(db)
        assert.deepEqual(await org.harvest({ uuid: primary }), { count: 1 })
        assert.equal((await read(db, { score: 1099 })).object.length, 1, 'stored indexes hydrate correctly after completion')
    } finally { hold.release(); await db.close() }
})

test('new updates coalesce separately from an in-flight write and the latest bytes survive cold hydration', async () => {
    const disk = new MemoryDisk(), hold = gate(), writes = []
    const execute = disk.access.bind(disk)
    disk.access = async request => {
        if (request.operation === 'write' && request.path === leafPath('live', scope.organization_id)) {
            writes.push(request.data)
            if (writes.length === 1) { hold.enter(); await hold.blocked }
        }
        return await execute(request)
    }
    const db = await createRuntime({}, { disk, size: 8 })
    try {
        assert.equal((await create(db, { uuid: 'live', score: 0 })).success, true)
        await hold.started
        for (const score of [1, 2]) {
            assert.equal((await db.send({ ...scope, method: 'object.update', object: { uuid: 'live', score } })).success, true)
            await waitForIndex(db)
        }
        assert.equal(JSON.parse(writes[0]).object.score, 0, 'later mutations cannot change bytes already handed to disk')
        assert.equal((await read(db, { score: 2 })).object.length, 1)
        hold.release()
        await waitForIdle(db)
        assert.deepEqual(writes.map(data => JSON.parse(data).object.score), [0, 2])
        assert.equal(JSON.parse(disk.readLeaf('live')).object.score, 2)
        const org = await db.organizations.get(scope.organization_id)
        await org.harvest()
        assert.equal((await read(db, { score: 0 })).object.length, 0)
        assert.equal((await read(db, { score: 1 })).object.length, 0)
        assert.equal((await read(db, { score: 2 })).object[0].uuid, 'live')
    } finally { hold.release(); await db.close() }
})

test('delete during an in-flight write remains the final intent and UUID reuse waits for storage completion', async () => {
    const disk = new MemoryDisk(), hold = gate()
    const execute = disk.access.bind(disk)
    let first = true
    disk.access = async request => {
        if (first && request.operation === 'write' && request.path === leafPath('gone', scope.organization_id)) {
            first = false; hold.enter(); await hold.blocked
        }
        return await execute(request)
    }
    const db = await createRuntime({}, { disk, size: 8 })
    try {
        assert.equal((await create(db, { uuid: 'gone', score: 1 })).success, true)
        await hold.started
        assert.equal((await db.send({ ...scope, method: 'object.delete', object: { uuid: 'gone' } })).success, true)
        await waitForIndex(db)
        assert.equal((await read(db, { score: 1 })).object.length, 0)
        const reuse = await db.send({ ...scope, array: 'neighbor', method: 'object.create', object: { uuid: 'gone', score: 3 } })
        assert.equal(reuse.success, false)
        hold.release()
        await waitForIdle(db)
        assert.equal(disk.hasLeaf('gone'), false)
        assert.equal((await create(db, { uuid: 'gone', score: 3 })).success, true)
        await waitForIdle(db)
        assert.equal(JSON.parse(disk.readLeaf('gone')).object.score, 3)
    } finally { hold.release(); await db.close() }
})

test('one attached Disk owns concurrency across Trees and close waits for all requests', async () => {
    const disk = new MemoryDisk(), hold = gate()
    const access = disk.access.bind(disk)
    let active = 0, peak = 0, written = 0
    disk.access = async request => {
        if (request.operation !== 'write') return await access(request)
        active++; peak = Math.max(peak, active)
        if (active === 16) hold.enter()
        await hold.blocked
        try { written++; return await access(request) } finally { active-- }
    }
    const db = await createRuntime({}, { disk })
    try {
        await Promise.all(Array.from({ length: 32 }, (_, index) => db.send({ ...scope,
            array: `items-${index}`, method: 'object.create', object: { value: index } })))
        await hold.started
        assert.equal(peak, 16)
        assert.ok(Object.keys(disk.queue).length > 0)
        hold.release()
        await db.close()
        assert.ok(written >= 32)
        assert.equal(peak, 16)
        assert.equal(Object.keys(disk.queue).length, 0)
    } finally { hold.release(); await db.close() }
})

test('a disk failure leaves storage pending without blocking indexed reads or enabling harvesting', async () => {
    const disk = new MemoryDisk(), fail = gate()
    const execute = disk.access.bind(disk)
    disk.access = async request => {
        if (request.operation === 'write' && request.path === leafPath('failed', scope.organization_id)) {
            fail.enter(); throw new Error('test disk failure')
        }
        return await execute(request)
    }
    const db = await createRuntime({}, { disk })
    try {
        const created = await create(db, { uuid: 'failed', score: 4 })
        assert.equal(created.success, true)
        await fail.started
        await waitForIndex(db)
        assert.equal((await read(db, { score: 4 })).object.length, 1)
        assert.ok(db.pendingDiskCount > 0)
        const org = await db.organizations.get(scope.organization_id)
        assert.deepEqual(await org.harvest({ uuid: created.object[0].parent }), { count: 0 })
        await assert.rejects(db.close(), /test disk failure/)
    } finally { await db.close().catch(() => {}) }
})


test('Disk and Persistence receive the same data independently and each queue protects harvesting', async () => {
    const disk = new MemoryDisk(), diskHold = gate(), persistenceHold = gate()
    const access = disk.access.bind(disk)
    disk.access = async request => {
        if (request.kind === 'leaf' && request.path === leafPath('independent', scope.organization_id) && request.operation === 'write') {
            diskHold.enter(); await diskHold.blocked
        }
        return await access(request)
    }
    const received = []
    const persistence = createStorage(async request => {
        if (request.operation === 'read') return undefined
        if (request.operation === 'has') return false
        received.push(request)
        if (request.uuid === 'independent' && request.operation === 'write') {
            persistenceHold.enter(); await persistenceHold.blocked
        }
        return true
    })
    const db = await createRuntime({}, { disk, persistence })
    try {
        const created = await create(db, { uuid: 'independent', value: 'ready' })
        assert.equal(created.success, true)
        const primary = created.object[0].parent
        await Promise.all([diskHold.started, persistenceHold.started])
        await waitForIndex(db)
        assert.equal(disk.queue[primary].leaves.independent, persistence.queue[primary].leaves.independent, 'both ports receive the same request')
        assert.equal(JSON.parse(received.find(request => request.uuid === 'independent').data).object.value, 'ready')
        const tree = await db.trees.get(scope.organization_id, primary)
        assert.equal(tree.disk, disk)
        assert.equal(tree.persistence, persistence)
        assert.equal(treeContexts.get(tree).canDrop, false)
        diskHold.release()
        await waitForCondition(() => !disk.queue[primary])
        assert.ok(persistence.queue[primary], 'Persistence makes progress on its own lifecycle')
        assert.equal(treeContexts.get(tree).canDrop, false)
        persistenceHold.release()
        await waitForIdle(db)
        assert.equal(treeContexts.get(tree).canDrop, true)
        assert.deepEqual(Object.keys(persistence.queue), [])
    } finally { diskHold.release(); persistenceHold.release(); await db.close() }
})


test('Persistence receives leaf, branch and config data even without a Disk adapter', async () => {
    const received = []
    const persistence = createStorage(async request => {
        if (request.operation === 'read') return undefined
        if (request.operation === 'has') return false
        received.push(request)
        return true
    })
    const db = await createRuntime({}, { persistence, size: 4 })
    try {
        const created = await create(db, { value: 'persistence-only' })
        assert.equal(created.success, true)
        await waitForIdle(db)
        const primary = created.object[0].parent
        const changes = received.filter(request => request.primary === primary)
        assert.ok(changes.some(request => request.kind === 'leaf' && JSON.parse(request.data).object.value === 'persistence-only'))
        assert.ok(changes.some(request => request.kind === 'branch' && JSON.parse(request.data).entries))
        assert.ok(changes.some(request => request.kind === 'config' && JSON.parse(request.data).indexes.length))
        assert.equal(Object.keys(persistence.queue).length, 0)
        const tree = await db.trees.get(scope.organization_id, primary)
        assert.equal(treeContexts.get(tree).canDrop, false, 'external writes alone do not establish local disk hydration')
    } finally { await db.close() }
})
