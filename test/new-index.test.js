import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Disk from '@cocreate/disk'
import { createDB, createIndex } from '../src/index.js'
import { leafPath, MemoryDisk } from '../test-support/memory-disk.mjs'

const envelope = { organization_id: 'index-org', storage: 'test', database: 'app', array: 'items' }

test('Index composes Tree, Query Planner, and CRUD and delegates requests', async () => {
    const index = await createIndex({ treeOptions: { deferIndex: false } })
    const created = await index.send({ ...envelope, method: 'object.create', object: { label: 'from-index' } })

    assert.equal(created.success, true, created.error?.join('; '))
    assert.equal(created.object.length, 1)
    const read = await index.send({ ...envelope, method: 'object.read', object: { uuid: created.object[0].uuid } })
    assert.equal(read.success, true, read.error?.join('; '))
    assert.equal(read.object[0].label, 'from-index')
    assert.ok(index.tree)
    assert.ok(index.planner)
    assert.ok(index.crud)
})

test('Index uses supplied config ahead of stored config', async () => {
    const stored = { version: 'stored', roots: { $tenant_id: { object: {} } } }
    const disk = new MemoryDisk(stored)
    const supplied = { version: 'supplied', roots: { $organization_id: { storage: { database: { array: { object: {} } } } } } }
    const index = await createIndex({ config: supplied, disk })

    assert.equal(index.config.version, 'supplied')
    assert.ok(index.config.roots.$organization_id)
})

test('Index falls back to config read from its Disk instance', async () => {
    const stored = {
        version: 'stored',
        roots: { $organization_id: { storage: { database: { array: { object: {} } } } } }
    }
    const disk = new MemoryDisk(stored)
    const index = await createIndex({ disk })

    assert.equal(index.config.version, 'stored')
})

test('Index delegates send to an injected CRUD resource', async () => {
    const tree = { config: { version: 'test', roots: {} } }
    const planner = { plan() { throw new Error('Index must not plan requests') } }
    const request = { method: 'object.read' }
    const crud = { async send(value) { assert.equal(value, request); return { success: true } } }
    const index = await createIndex({ tree, planner, crud })

    assert.deepEqual(await index.send(request), { success: true })
})

test('worker DB forwards requests through the supplied Server send primitive', async () => {
    const sent = []
    const worker = await createDB({
        isPrimary: false,
        isWorker: true,
        async send(envelope) {
            sent.push(envelope)
            return { uuid: envelope.uuid, result: { success: true, object: [{ uuid: 'from-primary' }] } }
        }
    })
    const request = { ...envelope, method: 'object.read', object: { uuid: 'from-primary' } }

    assert.deepEqual(await worker.send(request), { success: true, object: [{ uuid: 'from-primary' }] })
    assert.equal(sent.length, 1)
    assert.equal(sent[0].method, 'db.forward')
    assert.equal(sent[0].request, request)
    assert.equal(sent[0].primary, true)
    assert.equal(sent[0].broadcast, false)
})

test('primary DB handles db.forward requests and unregisters its listener on close', async () => {
    const server = new EventEmitter()
    server.isPrimary = true
    server.id = 'primary-db-test'
    server.emitAsync = async (event, payload) => {
        let result
        for (const listener of server.listeners(event)) result = await listener(payload)
        return result
    }
    const db = await createDB(server)
    const response = await server.emitAsync('db.forward', {
        uuid: 'forwarded-create',
        request: { ...envelope, method: 'object.create', object: { value: 'primary-db' } }
    })

    assert.equal(response.uuid, 'forwarded-create')
    assert.equal(response.result.success, true, response.result.error?.join('; '))
    assert.equal(server.listenerCount('db.forward'), 1)
    await db.close()
    assert.equal(server.listenerCount('db.forward'), 0)
})

test('shared package entry dynamically composes server disk and restores leaves after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cocreatedb-entry-'))
    const disk = await Disk.init({ directory })
    let db
    let restarted
    try {
        db = await createDB({ disk }, { mode: 'adaptive', treeOptions: { deferIndex: false } })
        const created = await db.send({
            ...envelope,
            method: 'object.create',
            object: { label: 'survives-entry-restart' }
        })
        assert.equal(created.success, true, created.error?.join('; '))
        const uuid = created.object[0].uuid
        await db.flushIndex()
        await db.flushDisk()
        await db.close()
        db = undefined

        restarted = await createDB({ disk }, { mode: 'adaptive', treeOptions: { deferIndex: false } })
        const read = await restarted.send({
            ...envelope,
            method: 'object.read',
            object: { uuid }
        })
        assert.equal(read.success, true, read.error?.join('; '))
        assert.equal(read.object[0].label, 'survives-entry-restart')
    } finally {
        await db?.close()
        await restarted?.close()
        await rm(directory, { recursive: true, force: true })
    }
})

test('Index attaches the Disk resource to Tree and Tree can replace it', async () => {
    const disk = new MemoryDisk()
    const requests = []
    const index = await createIndex({ disk, config: { roots: { $organization_id: { storage: { database: { array: { object: {} } } } } } } })
    assert.equal(index.tree.disk, disk)
    const execute = disk.execute.bind(disk)
    disk.execute = async request => { requests.push(request); return await execute(request) }

    const created = await index.send({ ...envelope, method: 'object.create', object: { value: 'disk-hook' } })
    await index.flushLocal()
    assert.equal(created.success, true, created.error?.join('; '))
    assert.ok(requests.every(request => typeof request.operation === 'string' && typeof request.kind === 'string'))
    assert.ok(requests.some(request => request.operation === 'write' && request.path.startsWith('leaves/')))
    assert.ok(requests.some(request => request.operation === 'write' && request.path.startsWith('branches/')))
    const leaf = await index.tree.getLeaf(created.object[0].uuid)
    await leaf.toDisk()
    const read = await index.send({ ...envelope, method: 'object.read', object: { uuid: leaf.uuid } })
    assert.equal(read.success, true, read.error?.join('; '))
    assert.equal(read.object[0].value, 'disk-hook')
    assert.ok(requests.some(request => request.operation === 'read' && request.path.startsWith('leaves/')))

    const resident = await index.tree.leaves.get(leaf.uuid)
    await resident.toDisk()
    const updated = await index.send({ ...envelope, method: 'object.update', object: { uuid: leaf.uuid, value: 'updated-from-disk' } })
    assert.equal(updated.success, true, updated.error?.join('; '))
    assert.equal(updated.object[0].value, 'updated-from-disk')
    await index.flushLocal()

    const updatedResident = await index.tree.leaves.get(leaf.uuid)
    await updatedResident.toDisk()
    const deleted = await index.send({ ...envelope, method: 'object.delete', object: { uuid: leaf.uuid } })
    assert.equal(deleted.success, true, deleted.error?.join('; '))
    await index.flushLocal()
    assert.equal(disk.hasLeaf(leaf.uuid), false)

    const replacementRequests = []
    index.disk = { async execute(request) { replacementRequests.push(request); return true } }
    await index.flushLocal()
    assert.ok(replacementRequests.some(request => request.operation === 'write' && request.path === 'config.json'))
})

test('DB without an attached disk operates in memory', async () => {
    const db = await createDB()
    const created = await db.send({ ...envelope, method: 'object.create', object: { value: 'memory-only' } })
    assert.equal(created.success, true, created.error?.join('; '))
    assert.equal(db.disk, undefined)
    assert.equal(db.mode, 'adaptive')
    assert.deepEqual(db.prune, { strategy: 'lfu' })
    assert.equal((await db.send({ ...envelope, method: 'object.read', object: { uuid: created.object[0].uuid } })).success, true)
    await db.flushDisk()
    await db.close()
})

test('create acknowledges the resident leaf before the queued local disk write, then persists leaves before index branches', async () => {
    const disk = new MemoryDisk()
    let beginWrite
    let releaseWrite
    const writeStarted = new Promise(resolve => { beginWrite = resolve })
    const blocked = new Promise(resolve => { releaseWrite = resolve })
    const events = []
    const execute = disk.execute.bind(disk)
    disk.execute = async request => {
        if (request.operation === 'write' && request.path.startsWith('leaves/')) {
            events.push('leaf-write-start')
            beginWrite()
            await blocked
            events.push('leaf-write-end')
        } else if (request.operation === 'write' && request.path.startsWith('branches/')) {
            events.push('branch-write')
        }
        return await execute(request)
    }
    const index = await createIndex({
        disk,
        config: { roots: { $organization_id: { storage: { database: { array: { object: {} } } } } } }
    })

    const response = await index.send({ ...envelope, method: 'object.create', object: { value: 'ack-first' } })
    assert.equal(response.success, true, response.error?.join('; '))
    assert.deepEqual(events, [], 'disk work starts only after the create response has been returned')
    assert.equal((await index.tree.leaves.get(response.object[0].uuid)).value, 'ack-first')
    await writeStarted
    assert.deepEqual(events, ['leaf-write-start'], 'the create response is not held behind the disk write')

    releaseWrite()
    await index.flushLocal()
    assert.ok(events.indexOf('leaf-write-end') < events.indexOf('branch-write'), 'leaf write finishes before index branches are written')
    await index.close()
})

test('update and delete acknowledge their map mutation before local disk work', { timeout: 5000 }, async () => {
    const disk = new MemoryDisk()
    const index = await createIndex({
        disk,
        config: { roots: { $organization_id: { storage: { database: { array: { object: {} } } } } } }
    })
    const created = await index.send({ ...envelope, method: 'object.create', object: { value: 'before' } })
    assert.equal(created.success, true, created.error?.join('; '))
    const uuid = created.object[0].uuid
    await index.flushLocal()

    let releaseLeafWrite
    let beginLeafWrite
    const updateEvents = []
    let leafWriteStarted = new Promise(resolve => { beginLeafWrite = resolve })
    let leafWriteBlocked = new Promise(resolve => { releaseLeafWrite = resolve })
    const execute = disk.execute.bind(disk)
    disk.execute = async request => {
        if (request.operation === 'write' && request.path.startsWith('leaves/')) {
            updateEvents.push('leaf-write-start')
            beginLeafWrite()
            await leafWriteBlocked
        }
        return await execute(request)
    }

    const updated = await index.send({ ...envelope, method: 'object.update', object: { uuid, value: 'after' } })
    assert.equal(updated.success, true, updated.error?.join('; '))
    assert.deepEqual(updateEvents, [], 'disk work starts only after the update response has been returned')
    assert.equal(updated.object[0].value, 'after')
    assert.equal((await index.tree.leaves.get(uuid)).value, 'after')
    await leafWriteStarted
    releaseLeafWrite()
    await index.flushLocal()
    assert.equal(JSON.parse(disk.files.get(leafPath(uuid))).object.value, 'after')

    let releaseLeafDelete
    let beginLeafDelete
    let leafDeleteCount = 0
    const leafDeleteStarted = new Promise(resolve => { beginLeafDelete = resolve })
    const leafDeleteBlocked = new Promise(resolve => { releaseLeafDelete = resolve })
    disk.execute = async request => {
        if (request.operation === 'delete' && request.path.startsWith('leaves/')) {
            leafDeleteCount++
            beginLeafDelete()
            await leafDeleteBlocked
        }
        return await execute(request)
    }

    const deleted = await index.send({ ...envelope, method: 'object.delete', object: { uuid } })
    assert.equal(deleted.success, true, deleted.error?.join('; '))
    assert.equal(leafDeleteCount, 0, 'disk deletion starts only after the delete response has been returned')
    assert.equal(deleted.object[0].uuid, uuid)
    assert.equal(await index.tree.leaves.get(uuid), undefined)
    await leafDeleteStarted
    const concurrentIndexFlush = index.flushIndex()
    releaseLeafDelete()
    await concurrentIndexFlush
    await index.flushLocal()
    assert.equal(disk.hasLeaf(uuid), false)
    assert.equal(leafDeleteCount, 1, 'overlapping flushes delete the leaf file only once')
    await index.close()
})

test('UUID reads resolve resident memory, local disk, then external persistence and cache fetched leaves locally', async () => {
    const disk = new MemoryDisk()
    const requests = []
    const externalLeaf = { uuid: 'external-leaf', root: 'object', value: 'from-persistence' }
    const index = await createIndex({
        disk,
        config: { roots: { $organization_id: { storage: { database: { array: { object: {} } } } } } },
        persistence: {
            async execute(operation) {
                requests.push(operation)
                return operation.operation === 'read' && operation.uuid === externalLeaf.uuid
                    ? externalLeaf
                    : { success: true }
            }
        }
    })

    const first = await index.send({ method: 'object.read', object: { uuid: externalLeaf.uuid } })
    assert.equal(first.success, true, first.error?.join('; '))
    assert.equal(first.object[0].value, 'from-persistence')
    assert.equal(requests.filter(request => request.operation === 'read').length, 1)

    const second = await index.send({ method: 'object.read', object: { uuid: externalLeaf.uuid } })
    assert.equal(second.object[0].value, 'from-persistence')
    assert.equal(requests.filter(request => request.operation === 'read').length, 1, 'resident hits avoid another external read')

    await index.flushLocal()
    assert.ok(disk.hasLeaf(externalLeaf.uuid), 'externally fetched leaf is cached to local disk')
    await index.close()
})

test('Tree sends mutation operations directly to the attached Persistence resource', async () => {
    const sent = []
    const persistence = {
        async execute(operation) { sent.push(operation); return { success: true } },
        async persist() { return { success: true, count: sent.length } }
    }
    const index = await createIndex({
        treeOptions: { deferIndex: false },
        persistence
    })
    const created = await index.send({ ...envelope, method: 'object.create', object: { value: 'persist-me' } })
    const leaf = created.object[0]

    assert.equal(created.success, true, created.error?.join('; '))
    assert.equal(index.tree.persistence, persistence)
    const leafOperations = () => sent.filter(operation => operation.uuid === leaf.uuid)
    assert.equal(leafOperations().length, 1)
    assert.equal(leafOperations()[0].operation, 'write')
    assert.equal(leafOperations()[0].kind, 'leaf')
    assert.equal(leafOperations()[0].data, leaf, 'Tree passes its live leaf without creating a snapshot')

    const pruned = await index.tree.prune({ limit: 1 })
    assert.equal(pruned.count, 1)
    assert.ok(sent.some(operation => operation.kind === 'branch' && operation.operation === 'write'))

    await index.send({ ...envelope, method: 'object.update', object: { uuid: leaf.uuid, value: 'updated' } })
    assert.equal(leafOperations().length, 2)
    assert.equal(leafOperations()[1].operation, 'write')
    assert.equal(leafOperations()[1].data, leaf)

    const flushed = await index.persist()
    assert.equal(flushed.success, true)
    assert.equal(flushed.count, sent.length)

    await index.send({ ...envelope, method: 'object.delete', object: { uuid: leaf.uuid } })
    assert.equal(leafOperations().length, 3)
    assert.equal(leafOperations()[2].operation, 'delete')
    assert.equal(leafOperations()[2].kind, 'leaf')
    await index.close()
})

test('Tree emits no Persistence operations when no resource is attached', async () => {
    const index = await createIndex()
    const created = await index.send({ ...envelope, method: 'object.create', object: { value: 'local-only' } })
    assert.equal(created.success, true, created.error?.join('; '))
    assert.equal(index.tree.persistence, undefined)
    assert.equal(index.persistence, undefined)
    assert.deepEqual(await index.persist(), { success: false, skipped: true })
    await index.close()
})

test('Index derives its memory budget from telemetry and asks Tree to prune at pressure stages', async () => {
    const server = new EventEmitter()
    server.id = 'memory-server'
    const calls = []
    const tree = {
        config: { version: 'test', roots: {} },
        disk: { async execute() { return true } },
        diskFirst: false,
        async prune(options) { calls.push(options); return { count: 1 } },
        setDiskFirst(value) { this.diskFirst = value; calls.push(`diskFirst:${value}`); return value }
    }
    const index = await createIndex({
        tree,
        server,
        memoryPercent: 25,
        planner: { plan() { return { strategy: 'scan', branches: [] } } },
        crud: { async send() { return { success: true } } }
    })
    const sample = (timestamp, max) => server.emit('telemetry', {
        data: { serverId: server.id, workerId: 1, timestamp, memory: { total: 1000, max } }
    })

    sample('t0', 50)
    assert.equal(index.memory.baselineUsedMemory, 500)
    assert.equal(index.memory.availableMemory, 500)
    assert.equal(index.memory.budget, 250)

    sample('t1', 52.5)
    await index.flushMemory()
    assert.equal(index.memory.stage, 1)
    assert.equal(calls.filter(call => typeof call === 'object').length, 1)
    assert.deepEqual(index.prune, { strategy: 'lfu' })
    assert.equal(calls[0].strategy, 'lfu')
    sample('t1', 52.5)
    await index.flushMemory()
    assert.equal(calls.filter(call => typeof call === 'object').length, 1, 'duplicate telemetry samples are ignored')

    sample('t2', 55)
    sample('t3', 72.5)
    await index.flushMemory()
    assert.equal(index.memory.stage, 8)
    assert.equal(calls.filter(call => typeof call === 'object').length, 8, 'each crossed pressure stage requests one prune cycle')
    assert.equal(index.memory.branchesPruned, 8)
    assert.equal(index.memory.diskFirst, true)

    sample('t4', 71.8)
    assert.equal(index.memory.diskFirst, false, 'disk-first clears below the hysteresis threshold')
    await index.close()
})

test('Index uses LFU for explicit prune configuration without a strategy', async () => {
    const tree = { config: { version: 'test', roots: {} }, disk: { async execute() {} }, async prune() {} }
    const index = await createIndex({
        tree,
        prune: { limit: 12 },
        planner: { plan() { return { strategy: 'scan', branches: [] } } },
        crud: { async send() { return { success: true } } }
    })
    assert.deepEqual(index.prune, { limit: 12, strategy: 'lfu' })
    await index.close()
})

test('disk-first requests acknowledge the live leaf and release it after local flushing', async () => {
    const disk = new MemoryDisk()
    const index = await createIndex({
        disk,
        config: { roots: { $organization_id: { storage: { database: { array: { object: {} } } } } } },
        treeOptions: { deferIndex: false }
    })
    index.tree.setDiskFirst(true)
    const response = await index.send({ ...envelope, method: 'object.create', object: { value: 'disk-first' } })

    assert.equal(response.success, true, response.error?.join('; '))
    assert.equal(typeof response.object[0].getFile, 'function', 'response returns the live Tree leaf')
    await index.flushLocal()
    assert.equal(disk.hasLeaf(response.object[0].uuid), true)
    const hydrated = await index.tree.getLeaf(response.object[0].uuid)
    assert.equal(hydrated.value, 'disk-first')
})
