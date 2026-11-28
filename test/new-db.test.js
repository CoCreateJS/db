import { testOrganization } from '../test-support/tree.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { waitForIdle, waitForCondition } from './benchmarks/shared/wait-for-index.mjs'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Disk from '@cocreate/disk'
import { createRuntime } from '../src/runtime.js'
import { Tree } from '../src/index.js'
import { createConfiguration } from '../src/runtime.js'
import { inspectTree } from '../test-support/tree.mjs'
import { leafPath, MemoryDisk } from '../test-support/memory-disk.mjs'

const envelope = { organization_id: 'index-org', storage: 'test', database: 'app', array: 'items' }
const treeFor = async index => inspectTree(await testOrganization(index, envelope.organization_id))
const createDatabase = async (options = {}) => {
    const { server = {}, ...dbOptions } = options
    return await createRuntime(server, dbOptions)
}

test('DB composes Tree, Query Planner, and CRUD and delegates requests', async () => {
    const index = await createDatabase()
    const created = await index.send({ ...envelope, method: 'object.create', object: { label: 'from-index' } })

    assert.equal(created.success, true, created.error?.join('; '))
    assert.equal(created.object.length, 1)
    const read = await index.send({ ...envelope, method: 'object.read', object: { uuid: created.object[0].uuid } })
    assert.equal(read.success, true, read.error?.join('; '))
    assert.equal(read.object[0].label, 'from-index')
    const tree = inspectTree(await testOrganization(index, envelope.organization_id))
    assert.equal(tree.organizationId, envelope.organization_id)
    assert.equal(typeof index.planner, 'function')
    await index.close()
})

test('DB uses supplied config ahead of stored config', async () => {
    const stored = { version: 'stored', roots: { $tenant_id: { object: {} } } }
    const disk = new MemoryDisk(stored)
    const supplied = { version: 'supplied', roots: { storage: { database: { array: { object: {} } } } } }
    const index = await createDatabase({ config: supplied, disk })

    assert.equal(index.config.version, 'supplied')
    assert.ok(index.config.roots.storage)
})

test('DB composes organization Trees from its supplied defaults rather than stored config', async () => {
    const stored = {
        version: 'stored',
        roots: { storage: { database: { array: { object: {} } } } }
    }
    const disk = new MemoryDisk(stored)
    disk.files.delete('config.json')
    disk.files.set(`${envelope.organization_id}/config.json`, JSON.stringify(stored))
    const index = await createDatabase({ disk })

    await testOrganization(index, envelope.organization_id)
    assert.equal((await treeFor(index)).config.version, '1.0.0')
    await index.close()
})

test('DB composes a custom execution function onto each selected primary Tree', async () => {
    const index = await createDatabase()
    const created = await index.send({ ...envelope, method: 'object.create', object: { value: 1 } })
    const organization = await testOrganization(index, envelope.organization_id)
    const tree = await organization.getTree(created.object[0].parent)
    const request = { ...envelope, method: 'object.read' }
    tree.execute = async value => { assert.equal(value, request); return { success: true } }
    assert.deepEqual(await index.send(request), { success: true })
    await index.close()
})

test('DB executes locally regardless of Server process role and unregisters telemetry on close', async () => {
    for (const isPrimary of [false, true]) {
        const server = new EventEmitter()
        Object.assign(server, { isPrimary, isWorker: true,
            send() { throw new Error('DB must not use Server transport') } })
        const db = await createRuntime(server)
        try {
            assert.deepEqual(server.eventNames(), ['telemetry'])
            const response = await db.send({ ...envelope, method: 'object.create', object: { value: 'local' } })
            assert.equal(response.success, true)
            const tree = await db.trees.get(envelope.organization_id, response.object[0].parent)
            assert.equal((await tree.leaves.get(response.object[0].uuid)).value, 'local')
        } finally { await db.close() }
        assert.deepEqual(server.eventNames(), [])
    }
})

test('shared package entry dynamically composes server disk and restores leaves after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cocreatedb-entry-'))
    const disk = await Disk.init({ directory })
    let db
    let restarted
    try {
        db = await createRuntime({ disk }, { mode: 'adaptive' })
        const created = await db.send({
            ...envelope,
            method: 'object.create',
            object: { label: 'survives-entry-restart' }
        })
        assert.equal(created.success, true, created.error?.join('; '))
        const uuid = created.object[0].uuid
        await waitForIdle(db)
        await waitForIdle(db)
        await db.close()
        db = undefined

        restarted = await createRuntime({ disk }, { mode: 'adaptive' })
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

test('DB attaches the Disk resource to Tree and Tree can replace it', async () => {
    const disk = new MemoryDisk()
    const requests = []
    const index = await createDatabase({ disk, config: { roots: { storage: { database: { array: { object: {} } } } } } })
    assert.equal((await treeFor(index)).disk, disk)
    const execute = disk.execute.bind(disk)
    disk.execute = async request => { requests.push(request); return await execute(request) }

    const created = await index.send({ ...envelope, method: 'object.create', object: { value: 'disk-hook' } })
    await waitForIdle(index)
    assert.equal(created.success, true, created.error?.join('; '))
    assert.ok(requests.every(request => typeof request.operation === 'string' && typeof request.kind === 'string'))
    assert.ok(requests.some(request => request.operation === 'write' && request.path.includes('leaves/')))
    assert.ok(requests.some(request => request.operation === 'write' && request.path.includes('branches/')))
    const leaf = await (await treeFor(index)).getLeaf(created.object[0].uuid)
    await (await treeFor(index)).harvest({ uuid: leaf.parent })
    const read = await index.send({ ...envelope, method: 'object.read', object: { uuid: leaf.uuid } })
    assert.equal(read.success, true, read.error?.join('; '))
    assert.equal(read.object[0].value, 'disk-hook')
    assert.ok(requests.some(request => request.operation === 'read' && request.path.includes('leaves/')))

    const resident = await (await treeFor(index)).leaves.get(leaf.uuid)
    await waitForIdle(index)
    await (await treeFor(index)).harvest({ uuid: resident.parent })
    const updated = await index.send({ ...envelope, method: 'object.update', object: { uuid: leaf.uuid, value: 'updated-from-disk' } })
    assert.equal(updated.success, true, updated.error?.join('; '))
    assert.equal(updated.object[0].value, 'updated-from-disk')
    await waitForIdle(index)

    const updatedResident = await (await treeFor(index)).leaves.get(leaf.uuid)
    await waitForIdle(index)
    await (await treeFor(index)).harvest({ uuid: updatedResident.parent })
    const deleted = await index.send({ ...envelope, method: 'object.delete', object: { uuid: leaf.uuid } })
    assert.equal(deleted.success, true, deleted.error?.join('; '))
    await waitForIdle(index)
    assert.equal(disk.hasLeaf(leaf.uuid), false)

    const replacementRequests = []
    index.disk = { queue: disk.queue, async execute(request) { replacementRequests.push(request); return await execute(request) } }
    const replacement = await index.send({ ...envelope, method: 'object.create', object: { value: 'replacement-disk' } })
    assert.equal(replacement.success, true, replacement.error?.join('; '))
    await waitForIdle(index)
    assert.ok(replacementRequests.some(request => request.operation === 'write' && request.path.includes('leaves/')))
    assert.ok(replacementRequests.some(request => request.operation === 'write' && request.path.includes('branches/')))
})

test('DB without an attached disk operates in memory', async () => {
    const db = await createRuntime()
    const created = await db.send({ ...envelope, method: 'object.create', object: { value: 'memory-only' } })
    assert.equal(created.success, true, created.error?.join('; '))
    assert.equal(db.disk, undefined)
    assert.equal(db.mode, 'adaptive')
    assert.deepEqual(db.config.memory, { harvestAt: 75, retainAt: 50 })
    assert.equal((await db.send({ ...envelope, method: 'object.read', object: { uuid: created.object[0].uuid } })).success, true)
    await waitForIdle(db)
    await db.close()
})

test('create acknowledges the resident leaf before the queued local disk write, and hands off all changed files without disk ordering barriers', async () => {
    const disk = new MemoryDisk()
    let beginWrite
    let releaseWrite
    const writeStarted = new Promise(resolve => { beginWrite = resolve })
    const blocked = new Promise(resolve => { releaseWrite = resolve })
    const events = []
    const execute = disk.execute.bind(disk)
    disk.execute = async request => {
        if (request.operation === 'write' && request.path.includes('leaves/')) {
            events.push('leaf-write-start')
            beginWrite()
            await blocked
            events.push('leaf-write-end')
        } else if (request.operation === 'write' && request.path.includes('branches/')) {
            events.push('branch-write')
        }
        return await execute(request)
    }
    const index = await createDatabase({
        disk,
        config: { roots: { storage: { database: { array: { object: {} } } } } }
    })

    const response = await index.send({ ...envelope, method: 'object.create', object: { value: 'ack-first' } })
    assert.equal(response.success, true, response.error?.join('; '))
    assert.deepEqual(events, [], 'disk work starts only after the create response has been returned')
    assert.equal((await (await treeFor(index)).leaves.get(response.object[0].uuid)).value, 'ack-first')
    await writeStarted
    assert.ok(events.includes('leaf-write-start'), 'leaf writes begin after acknowledgement')

    releaseWrite()
    await waitForIdle(index)
    assert.ok(events.includes('leaf-write-end') && events.includes('branch-write'), 'both file kinds complete through the adapter')
    await index.close()
})

test('update and delete acknowledge their map mutation before local disk work', { timeout: 5000 }, async () => {
    const disk = new MemoryDisk()
    const index = await createDatabase({
        disk,
        config: { roots: { storage: { database: { array: { object: {} } } } } }
    })
    const created = await index.send({ ...envelope, method: 'object.create', object: { value: 'before' } })
    assert.equal(created.success, true, created.error?.join('; '))
    const uuid = created.object[0].uuid
    await waitForIdle(index)

    let releaseLeafWrite
    let beginLeafWrite
    const updateEvents = []
    let leafWriteStarted = new Promise(resolve => { beginLeafWrite = resolve })
    let leafWriteBlocked = new Promise(resolve => { releaseLeafWrite = resolve })
    const execute = disk.execute.bind(disk)
    disk.execute = async request => {
        if (request.operation === 'write' && request.path.includes('leaves/')) {
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
    assert.equal((await (await treeFor(index)).leaves.get(uuid)).value, 'after')
    await leafWriteStarted
    releaseLeafWrite()
    await waitForIdle(index)
    assert.equal(JSON.parse(disk.files.get(leafPath(uuid, envelope.organization_id))).object.value, 'after')

    let releaseLeafDelete
    let beginLeafDelete
    let leafDeleteCount = 0
    const leafDeleteStarted = new Promise(resolve => { beginLeafDelete = resolve })
    const leafDeleteBlocked = new Promise(resolve => { releaseLeafDelete = resolve })
    disk.execute = async request => {
        if (request.operation === 'delete' && request.path.includes('leaves/')) {
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
    assert.equal(await (await treeFor(index)).leaves.get(uuid), undefined)
    await leafDeleteStarted
    releaseLeafDelete()
    await waitForIdle(index)
    assert.equal(disk.hasLeaf(uuid), false)
    assert.equal(leafDeleteCount, 1, 'automatic index work deletes the leaf file only once')
    await index.close()
})

test('UUID reads resolve resident memory, local disk, then external persistence and cache fetched leaves locally', async () => {
    const disk = new MemoryDisk()
    const requests = []
    const externalLeaf = { uuid: 'external-leaf', root: 'object', value: 'from-persistence' }
    const index = await createDatabase({
        disk,
        config: { roots: { storage: { database: { array: { object: {} } } } } },
        persistence: { queue: {},
            async execute(operation) {
                requests.push(operation)
                return operation.operation === 'read' && operation.uuid === externalLeaf.uuid
                    ? externalLeaf
                    : { success: true }
            }
        }
    })

    const seed = await index.send({ ...envelope, method: 'object.create', object: { value: 'local' } })
    externalLeaf.parent = seed.object[0].parent
    await waitForIdle(index)
    const first = await index.send({ ...envelope, method: 'object.read', object: { uuid: externalLeaf.uuid } })
    assert.equal(first.success, true, first.error?.join('; '))
    assert.equal(first.object[0].value, 'from-persistence')
    assert.equal(requests.filter(request => request.operation === 'read').length, 1)

    const second = await index.send({ ...envelope, method: 'object.read', object: { uuid: externalLeaf.uuid } })
    assert.equal(second.object[0].value, 'from-persistence')
    assert.equal(requests.filter(request => request.operation === 'read').length, 1, 'resident hits avoid another external read')

    await waitForCondition(() => disk.hasLeaf(externalLeaf.uuid))
    assert.equal(index.pendingIndexCount, 0, 'hydration does not queue indexing')
    assert.ok(disk.hasLeaf(externalLeaf.uuid), 'externally fetched leaf is cached to local disk')
    await index.close()
})

test('Tree sends serialized changes independently to Disk and Persistence after indexing', async () => {
    const sent = []
    const disk = new MemoryDisk()
    const persistence = { queue: {},
        async execute(operation) { sent.push(operation); return { success: true } },
        async persist() { return { success: true, count: sent.length } }
    }
    const index = await createDatabase({
        disk,
        persistence
    })
    const created = await index.send({ ...envelope, method: 'object.create', object: { value: 'persist-me' } })
    const leaf = created.object[0]

    assert.equal(created.success, true, created.error?.join('; '))
    assert.equal((await treeFor(index)).persistence, persistence)
    const leafOperations = () => sent.filter(operation => operation.uuid === leaf.uuid)
    assert.equal(leafOperations().length, 0, 'Persistence is notified only after indexing')
    await waitForIdle(index)
    assert.equal(leafOperations().length, 1)
    assert.equal(leafOperations()[0].operation, 'write')
    assert.equal(leafOperations()[0].kind, 'leaf')
    assert.equal(leafOperations()[0].organization_id, envelope.organization_id)
    assert.equal(JSON.parse(leafOperations()[0].data).object.value, 'persist-me', 'Persistence receives serialized file data')
    const branchOperations = () => sent.filter(operation => operation.kind === 'branch')
    assert.ok(branchOperations().some(operation => operation.operation === 'write' && typeof operation.data === 'string'),
        'the indexer notifies Persistence about changed branch IDs after writing their local files')
    assert.ok(branchOperations().every(operation => typeof operation.data === 'string'))
    const notificationsBeforeHarvest = sent.length
    const harvested = await (await treeFor(index)).harvest({ limit: 1 })
    assert.equal(harvested.count, 1)
    assert.equal(sent.length, notificationsBeforeHarvest, 'harvesting does not resend already persisted branch records')

    await index.send({ ...envelope, method: 'object.update', object: { uuid: leaf.uuid, value: 'updated' } })
    assert.equal(leafOperations().length, 1, 'Persistence is not notified before the update is indexed')
    await waitForIdle(index)
    assert.equal(leafOperations().length, 2)
    assert.equal(leafOperations()[1].operation, 'write')
    assert.equal(JSON.parse(leafOperations()[1].data).object.value, 'updated')

    const flushed = await (await (await testOrganization(index, envelope.organization_id)).getTree(leaf.parent)).persist()
    assert.equal(flushed.success, true)
    assert.equal(flushed.count, sent.length)

    await index.send({ ...envelope, method: 'object.delete', object: { uuid: leaf.uuid } })
    assert.equal(leafOperations().length, 2, 'Persistence is not notified before the deletion is indexed')
    await waitForIdle(index)
    assert.equal(leafOperations().length, 3)
    assert.equal(leafOperations()[2].operation, 'delete')
    assert.equal(leafOperations()[2].kind, 'leaf')
    await index.close()
})

test('Tree emits no Persistence operations when no resource is attached', async () => {
    const index = await createDatabase()
    const created = await index.send({ ...envelope, method: 'object.create', object: { value: 'local-only' } })
    assert.equal(created.success, true, created.error?.join('; '))
    const tree = await treeFor(index)
    const request = { operation: 'write', kind: 'leaf', uuid: 'unattached' }
    assert.equal(await tree.persistence.execute(request), request)
    assert.equal(await tree.disk.execute(request), request)
    assert.equal(await tree.persistence.execute({ operation: 'read', kind: 'leaf', uuid: 'missing' }), undefined)
    assert.equal(await tree.disk.execute({ operation: 'has', kind: 'file', path: 'missing' }), false)
    assert.deepEqual(await tree.disk.execute({ operation: 'list', kind: 'directory' }), [])
    const primary = await tree.getTree(created.object[0].parent)
    assert.throws(() => primary.setDiskFirst(true), /requires a disk handler/)
    assert.equal(index.persistence, undefined)
    assert.deepEqual(await primary.persist(), { success: false, skipped: true })
    await index.close()
})

test('disk-first requests acknowledge the live leaf and release it after queued index work', async () => {
    const disk = new MemoryDisk()
    let leafReads = 0
    const execute = disk.execute.bind(disk)
    disk.execute = async request => {
        if (request.operation === 'read' && request.path?.includes('leaves/')) leafReads++
        return await execute(request)
    }
    const index = await createDatabase({
        disk,
        config: { roots: { storage: { database: { array: { object: {} } } } } },
    })
    const tree = await treeFor(index)
    index.setDiskFirst(true)
    const response = await index.send({ ...envelope, method: 'object.create', object: { value: 'disk-first' } })

    assert.equal(response.success, true, response.error?.join('; '))
    assert.equal(typeof response.object[0].getFile, 'function', 'response returns the live Tree leaf')
    await waitForIdle(index)
    assert.equal(disk.hasLeaf(response.object[0].uuid), true)
    assert.equal(leafReads, 0, 'index completion releases the in-memory leaf without rereading it')
    const hydrated = await index.send({ ...envelope, method: 'object.read', object: { uuid: response.object[0].uuid } })
    assert.equal(hydrated.object[0].value, 'disk-first')
    assert.equal(leafReads, 1, 'the next access hydrates the released leaf from disk')
})
