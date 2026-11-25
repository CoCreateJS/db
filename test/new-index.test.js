import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDB, createIndex, createStorageDisk } from '../src/index.js'

const envelope = { organization_id: 'index-org', storage: 'test', database: 'app', array: 'items' }

class MemoryStorage {
    constructor(config) {
        this.directory = 'memory'
        this.branchDirectory = 'branches'
        this.leafDirectory = 'leaves'
        this.config = config
        this.initializeCount = 0
        this.branches = new Map()
        this.leaves = new Map()
    }

    async initialize() { this.initializeCount++ }
    async readConfig() { return JSON.stringify(this.config) }
    async writeConfig(value) { this.config = JSON.parse(value) }
    async readBranch(id) { return this.branches.get(id) }
    async writeBranch(id, value) { this.branches.set(id, value) }
    async deleteBranch(id) { this.branches.delete(id) }
    async hasBranch(id) { return this.branches.has(id) }
    async listBranches() { return [...this.branches.keys()] }
    async readLeaf(id) { return this.leaves.get(id) }
    async writeLeaf(id, value) { this.leaves.set(id, value) }
    async deleteLeaf(id) { this.leaves.delete(id) }
    async hasLeaf(id) { return this.leaves.has(id) }
    async listLeaves() { return [...this.leaves.keys()] }
}

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
    const storage = new MemoryStorage(stored)
    const supplied = { version: 'supplied', roots: { $organization_id: { storage: { database: { array: { object: {} } } } } } }
    const index = await createIndex({ config: supplied, storage })

    assert.equal(index.config.version, 'supplied')
    assert.ok(index.config.roots.$organization_id)
    assert.equal(storage.initializeCount, 1)
})

test('Index falls back to stored config and initializes storage once', async () => {
    const stored = {
        version: 'stored',
        roots: { $organization_id: { storage: { database: { array: { object: {} } } } } }
    }
    const storage = new MemoryStorage(stored)
    const index = await createIndex({ storage })

    assert.equal(index.config.version, 'stored')
    assert.equal(storage.initializeCount, 1)
})

test('Index delegates send to an injected CRUD resource', async () => {
    const tree = { config: { version: 'test', roots: {} } }
    const planner = { plan() { throw new Error('Index must not plan requests') } }
    const request = { method: 'object.read' }
    const crud = { async send(value) { assert.equal(value, request); return { success: true } } }
    const index = await createIndex({ tree, planner, crud })

    assert.deepEqual(await index.send(request), { success: true })
})

test('shared package entry dynamically composes server disk and restores leaves after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cocreatedb-entry-'))
    let db
    let restarted
    try {
        db = await createDB({}, { directory, mode: 'adaptive', treeOptions: { deferIndex: false } })
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

        restarted = await createDB({}, { directory, mode: 'adaptive', treeOptions: { deferIndex: false } })
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

test('Tree disk hook uses async envelopes and can be replaced after initialization', async () => {
    const storage = new MemoryStorage()
    const provider = createStorageDisk(storage)
    const requests = []
    const disk = async envelope => { requests.push(envelope); return await provider(envelope) }
    const index = await createIndex({ disk, config: { roots: { $organization_id: { storage: { database: { array: { object: {} } } } } } } })

    const created = await index.send({ ...envelope, method: 'object.create', object: { value: 'disk-hook' } })
    await index.flushLocal()
    assert.equal(created.success, true, created.error?.join('; '))
    assert.ok(requests.every(request => request && typeof request.method === 'string' && request.disk))
    assert.ok(requests.some(request => request.method === 'disk.initialize'))
    assert.ok(requests.some(request => request.method === 'disk.write' && request.disk.kind === 'leaf'))
    assert.ok(requests.some(request => request.method === 'disk.write' && request.disk.kind === 'branch'))
    const leaf = await index.tree.getLeaf(created.object[0].uuid)
    await leaf.toDisk()
    const read = await index.send({ ...envelope, method: 'object.read', object: { uuid: leaf.uuid } })
    assert.equal(read.success, true, read.error?.join('; '))
    assert.equal(read.object[0].value, 'disk-hook')
    assert.ok(requests.some(request => request.method === 'disk.read' && request.disk.kind === 'leaf'))

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
    assert.equal(storage.leaves.has(leaf.uuid), false)

    const replacementRequests = []
    index.disk = async request => { replacementRequests.push(request); return { success: true, data: [] } }
    await index.flushLocal()
    assert.ok(replacementRequests.length > 0)
})

test('create acknowledges the resident leaf before the queued local disk write, then persists leaves before index branches', async () => {
    const storage = new MemoryStorage()
    let beginWrite
    let releaseWrite
    const writeStarted = new Promise(resolve => { beginWrite = resolve })
    const blocked = new Promise(resolve => { releaseWrite = resolve })
    const writeLeaf = storage.writeLeaf.bind(storage)
    const writeBranch = storage.writeBranch.bind(storage)
    const events = []
    storage.writeLeaf = async (id, value) => {
        events.push('leaf-write-start')
        beginWrite()
        await blocked
        events.push('leaf-write-end')
        return await writeLeaf(id, value)
    }
    storage.writeBranch = async (id, value) => {
        events.push('branch-write')
        return await writeBranch(id, value)
    }
    const index = await createIndex({
        storage,
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
    const storage = new MemoryStorage()
    const index = await createIndex({
        storage,
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
    const writeLeaf = storage.writeLeaf.bind(storage)
    storage.writeLeaf = async (id, value) => {
        updateEvents.push('leaf-write-start')
        beginLeafWrite()
        await leafWriteBlocked
        return await writeLeaf(id, value)
    }

    const updated = await index.send({ ...envelope, method: 'object.update', object: { uuid, value: 'after' } })
    assert.equal(updated.success, true, updated.error?.join('; '))
    assert.deepEqual(updateEvents, [], 'disk work starts only after the update response has been returned')
    assert.equal(updated.object[0].value, 'after')
    assert.equal((await index.tree.leaves.get(uuid)).value, 'after')
    await leafWriteStarted
    releaseLeafWrite()
    await index.flushLocal()
    assert.equal(JSON.parse(storage.leaves.get(uuid)).object.value, 'after')

    let releaseLeafDelete
    let beginLeafDelete
    let leafDeleteCount = 0
    const leafDeleteStarted = new Promise(resolve => { beginLeafDelete = resolve })
    const leafDeleteBlocked = new Promise(resolve => { releaseLeafDelete = resolve })
    const deleteLeaf = storage.deleteLeaf.bind(storage)
    storage.deleteLeaf = async id => {
        leafDeleteCount++
        beginLeafDelete()
        await leafDeleteBlocked
        return await deleteLeaf(id)
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
    assert.equal(storage.leaves.has(uuid), false)
    assert.equal(leafDeleteCount, 1, 'overlapping flushes delete the leaf file only once')
    await index.close()
})

test('UUID reads resolve resident memory, local disk, then external persistence and cache fetched leaves locally', async () => {
    const storage = new MemoryStorage()
    const requests = []
    const externalLeaf = { uuid: 'external-leaf', root: 'object', value: 'from-persistence' }
    const index = await createIndex({
        storage,
        config: { roots: { $organization_id: { storage: { database: { array: { object: {} } } } } } },
        persistenceSend: async request => {
            requests.push(request)
            return request.method === 'persistence.read' && request.persistence.uuid === externalLeaf.uuid
                ? { success: true, persistence: externalLeaf }
                : { success: true }
        }
    })

    const first = await index.send({ method: 'object.read', object: { uuid: externalLeaf.uuid } })
    assert.equal(first.success, true, first.error?.join('; '))
    assert.equal(first.object[0].value, 'from-persistence')
    assert.equal(requests.filter(request => request.method === 'persistence.read').length, 1)

    const second = await index.send({ method: 'object.read', object: { uuid: externalLeaf.uuid } })
    assert.equal(second.object[0].value, 'from-persistence')
    assert.equal(requests.filter(request => request.method === 'persistence.read').length, 1, 'resident hits avoid another external read')

    await index.flushLocal()
    assert.ok(storage.leaves.has(externalLeaf.uuid), 'externally fetched leaf is cached to local disk')
    await index.close()
})

test('Tree persist hook stages grouped UUID operations and Index controls dispatch', async () => {
    const sent = []
    const index = await createIndex({
        treeOptions: { deferIndex: false },
        persistenceSend: async request => { sent.push(request); return { success: true } }
    })
    const created = await index.send({ ...envelope, method: 'object.create', object: { value: 'persist-me' } })
    const leaf = created.object[0]
    const group = Object.values(index.persistence.pending).find(items => items[leaf.uuid])

    assert.equal(created.success, true, created.error?.join('; '))
    assert.ok(group)
    assert.equal(group[leaf.uuid].op, 'upsert')
    assert.equal(sent.length, 0, 'staging does not dispatch external persistence')

    const flushed = await index.persist()
    assert.equal(flushed.success, true)
    const persistedLeaf = sent.find(request => request.persistence?.uuid === leaf.uuid)
    assert.equal(persistedLeaf?.method, 'persistence.upsert')
    assert.equal(persistedLeaf.persistence.uuid, leaf.uuid)
    assert.equal(Object.keys(index.persistence.pending).length, 0)

    await index.send({ ...envelope, method: 'object.delete', object: { uuid: leaf.uuid } })
    const pendingDelete = Object.values(index.persistence.pending).find(items => items[leaf.uuid])
    assert.equal(pendingDelete[leaf.uuid].op, 'delete')
    await index.persist()
    assert.ok(sent.some(request => request.method === 'persistence.delete' && request.persistence.uuid === leaf.uuid))
})

test('Index derives its memory budget from telemetry and asks Tree to shed at pressure stages', async () => {
    const server = new EventEmitter()
    server.id = 'memory-server'
    const calls = []
    const tree = {
        config: { version: 'test', roots: {} },
        diskFirst: false,
        async shed() { calls.push('shed'); return { count: 1 } },
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
    assert.equal(calls.filter(call => call === 'shed').length, 1)
    sample('t1', 52.5)
    await index.flushMemory()
    assert.equal(calls.filter(call => call === 'shed').length, 1, 'duplicate telemetry samples are ignored')

    sample('t2', 55)
    sample('t3', 72.5)
    await index.flushMemory()
    assert.equal(index.memory.stage, 8)
    assert.equal(calls.filter(call => call === 'shed').length, 8, 'each crossed pressure stage requests one shed cycle')
    assert.equal(index.memory.diskFirst, true)

    sample('t4', 71.8)
    assert.equal(index.memory.diskFirst, false, 'disk-first clears below the hysteresis threshold')
    await index.close()
})

test('temporary disk-first requests flush locally, shed residency, and return snapshots', async () => {
    const storage = new MemoryStorage()
    const index = await createIndex({
        storage,
        config: { roots: { $organization_id: { storage: { database: { array: { object: {} } } } } } },
        treeOptions: { deferIndex: false }
    })
    index.tree.setDiskFirst(true)
    const response = await index.send({ ...envelope, method: 'object.create', object: { value: 'disk-first' } })

    assert.equal(response.success, true, response.error?.join('; '))
    assert.equal(typeof response.object[0].getFile, 'undefined', 'response is detached before Tree evicts its live leaf')
    assert.equal(storage.leaves.has(response.object[0].uuid), true)
    const hydrated = await index.tree.getLeaf(response.object[0].uuid)
    assert.equal(hydrated.value, 'disk-first')
})
