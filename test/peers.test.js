import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { initializeServerDB } from '../src/index.js'
import { createPeerDistribution } from '../src/peers.js'
import { createDistributionIndex } from '../src/distribution.js'
import { createDB as createEngine } from '../src/object/index.js'
import { fileId } from '../src/files.js'
import { removeMemoryPath } from '../src/memory.js'

const scope = { organization_id: '000000000000000000000001', storage: 'production', database: 'app', array: 'items' }
const entity = { ...scope, storageId: '000000000000000000000099', databaseId: '000000000000000000000002' }
const empty = { entities: [], partitions: [] }
const cleanup = new WeakMap()

test('peer snapshots replace only that peer, exclude self, and reject older revisions/sessions', () => {
    const peers = createPeerDistribution('self')
    const snapshot = { entities: [entity], partitions: [{ partitionId: 'one/index.json' }] }
    peers.replace('one', snapshot, 'session-1', 1)
    peers.replace('two', snapshot, 'session-2', 1)
    peers.replace('self', snapshot, 'self-session', 1)
    assert.deepEqual(peers.get(entity), ['one', 'two'])
    peers.change({ ...entity, nodeId: 'one', operation: 'remove' }, 'session-1', 3)
    peers.replace('one', snapshot, 'session-1', 2)
    assert.deepEqual(peers.get(entity), ['two'])
    peers.replace('one', empty, 'restarted', 0)
    peers.replace('one', snapshot, 'session-1', 100)
    assert.deepEqual(peers.getPartition('one/index.json'), ['two'])
    peers.remove('two')
    assert.deepEqual(peers.get(entity), [])
    peers.replace('two', snapshot, 'session-2', 2)
    assert.deepEqual(peers.get(entity), [])
    peers.connect('two')
    peers.replace('two', snapshot, 'session-2', 2)
    assert.deepEqual(peers.get(entity), ['two'])
})

async function fixture(t, id, options = {}, directory) {
    directory ??= await mkdtemp(join(tmpdir(), 'coc-peer-inventory-'))
    const cluster = Object.assign(new EventEmitter(), { send: () => {} })
    const server = Object.assign(new EventEmitter(), { id, isPrimary: true, cluster })
    server.send = async payload => {
        const values = await Promise.all(server.rawListeners(payload.method).map(listener => listener(payload)))
        return values[0] ?? payload
    }
    initializeServerDB(server, { directory, ...options })
    if (!cleanup.has(t)) cleanup.set(t, new Map())
    const directories = cleanup.get(t)
    if (!directories.has(directory)) {
        directories.set(directory, [])
        t.after(async () => {
            for (const db of directories.get(directory).toReversed()) await db.close()
            removeMemoryPath(directory)
            await rm(directory, { recursive: true, force: true })
        })
    }
    directories.get(directory).push(server.db)
    return { server, directory, db: server.db }
}

for (const disk of [true, false]) test(`local inventory follows disk=${disk}; peer inventory never writes files`, async t => {
    const { server, directory, db } = await fixture(t, 'local', { disk })
    const created = await db.send({ ...scope, method: 'object.create', object: { value: 7 } })
    assert.equal(created.success, true)
    await db.flush()
    const inventory = await db.distribution.local.snapshot()
    assert.ok(inventory.entities.some(value => value.objectId === fileId(created.object[0])))
    assert.ok(inventory.partitions.length)
    const announce = { method: 'db.distribution', serverId: 'peer-only-id', nodeId: 'peer-only-id', ...inventory.entities[0], operation: 'add' }
    await Promise.all(server.cluster.rawListeners(announce.method).map(listener => listener(announce)))
    assert.deepEqual(db.distribution.peers.get(inventory.entities[0]), ['peer-only-id'])
    await db.flush()
    if (!disk) assert.deepEqual(await readdir(directory), [])
    else {
        async function contents(path) {
            const entries = await readdir(path, { withFileTypes: true })
            return (await Promise.all(entries.map(value => value.isDirectory() ? contents(join(path, value.name)) : readFile(join(path, value.name), 'utf8')))).join('\n')
        }
        assert.equal((await contents(directory)).includes('peer-only-id'), false)
    }
})

test('restart advertises saved local inventory under the new server ID without restoring peers', async t => {
    const first = await fixture(t, 'before')
    const created = await first.db.send({ ...scope, method: 'object.create', object: { value: 1, tags: ['shared'] } })
    await first.db.flush()
    const snapshot = await first.db.distribution.local.snapshot()
    first.db.distribution.peers.replace('peer', snapshot, 'peer-session', 1)
    await first.db.close()
    removeMemoryPath(first.directory)
    const restarted = await fixture(t, 'after', {}, first.directory)
    const inventory = await restarted.db.distribution.local.snapshot()
    assert.ok(inventory.entities.some(value => value.objectId === fileId(created.object[0])))
    assert.deepEqual(restarted.db.distribution.peers.get(snapshot.entities[0]), [])
    assert.deepEqual(await restarted.db.getDistribution(inventory.entities.find(value => value.objectId)), ['after'])
})

test('legacy combined inventories retain the current owner and drop foreign disk claims', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'coc-legacy-inventory-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const legacy = createDistributionIndex({ directory })
    const value = { databaseId: entity.databaseId, operation: 'add' }
    await legacy.update({ ...value, nodeId: 'owner' })
    await legacy.update({ ...value, nodeId: 'peer' })
    const local = createDistributionIndex({ directory, nodeId: 'owner' })
    assert.deepEqual(await local.get(value), ['owner'])
    assert.deepEqual(await createDistributionIndex({ directory }).get(value), ['local'])
})

test('disk=false does not disable the configured external recovery interface', async t => {
    const { db, directory } = await fixture(t, 'diskless', { disk: false, externalPersistence: true })
    assert.equal(db.persistence.enabled, true)
    assert.deepEqual(await readdir(directory), [])
})

test('partial standalone adapters retain the local/peer split for entity and partition updates', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'coc-partial-adapters-'))
    const db = createEngine({ directory, nodeId: 'self', disk: false, distributionAdapter: {}, partitionAdapter: {} })
    t.after(async () => { await db.close(); removeMemoryPath(directory); await rm(directory, { recursive: true, force: true }) })
    await db.updateDistribution({ databaseId: entity.databaseId, nodeId: 'peer', operation: 'add' })
    await db.updatePartition({ partitionId: 'part/index.json', nodeId: 'peer', operation: 'add' })
    assert.deepEqual(await db.getDistribution({ databaseId: entity.databaseId }), ['peer'])
    assert.deepEqual(await db.getPartitionHolders('part/index.json'), ['peer'])
    assert.deepEqual(await db.distribution.local.list(), [])
    assert.equal((await db.distribution.local.listPartitions()).some(value => value.nodeIds.includes('peer')), false)
    assert.deepEqual(await readdir(directory), [])
})

test('connecting peers exchange local inventories once, then apply changes and forget disconnects', async t => {
    const first = await fixture(t, 'one', { disk: false })
    const second = await fixture(t, 'two', { disk: false })
    const created = await first.db.send({ ...scope, method: 'object.create', object: { value: 1, tags: ['shared'] } })
    await first.db.flush()
    const pending = new Set(), messages = []
    for (const [source, target] of [[first.server, second.server], [second.server, first.server]]) {
        source.cluster.send = payload => {
            if (payload.server && payload.server !== target.id) return
            const message = JSON.parse(JSON.stringify(payload))
            messages.push(message)
            for (const listener of target.cluster.rawListeners(message.method)) {
                const task = Promise.resolve().then(() => listener(message))
                pending.add(task)
                task.then(() => pending.delete(task), () => {})
            }
        }
    }
    async function settle() {
        for (let i = 0; i < 20; i++) {
            await Promise.all([first.db.flush(), second.db.flush()])
            await setImmediate()
            if (!pending.size) return
            await Promise.all([...pending])
        }
        assert.fail('inventory exchange did not settle')
    }
    first.server.cluster.emit('peerConnected', { nodeId: 'two' })
    await settle()
    assert.equal(messages.filter(value => value.method === 'db.distribution.sync').length, 2)
    const local = await first.db.distribution.local.snapshot()
    const object = local.entities.find(value => value.objectId === fileId(created.object[0]))
    assert.deepEqual(second.db.distribution.peers.get(object), ['one'])
    const fetched = await second.db.send({ ...scope, method: 'object.read', filter: { query: { tags: { $in: ['shared'] } } } })
    assert.equal(fetched.success, true, fetched.error?.join('; '))
    assert.equal(fetched.object[0].value, 1)
    assert.equal(fileId(fetched.object[0]), fileId(created.object[0]))
    assert.ok(messages.some(value => value.method === 'db.document.request' && value.type === 'value'))
    await settle()
    assert.equal(second.db.persistenceStats().backgroundError, undefined)
    assert.equal(second.db.persistenceStats().indexError, undefined)
    const tags = (await first.db.index.read(scope, 'app', 'items', 'tags')).indexes.array
    assert.ok((await first.db.getPartitionHolders(`${scope.organization_id}/indexes/${tags.id}.json`)).includes('two'),
        'read follow-up registers the queried partition before later changes')
    await first.db.send({ ...scope, method: 'object.update', object: { _id: created.object[0]._id, $update: { $inc: { value: 2 } } } })
    await first.db.flush()
    await settle()
    assert.equal(first.db.persistenceStats().indexError, undefined)
    assert.equal(first.db.persistenceStats().backgroundError, undefined)
    assert.ok(messages.some(value => value.method === 'db.object.mutation' && value.operation === 'update'), 'registered peer receives the update patch')
    assert.equal(fetched.object[0].value, 3, 'peer patches mutate the acquired object reference')
    await first.db.send({ ...scope, method: 'object.delete', object: { _id: created.object[0]._id } })
    await settle()
    assert.deepEqual(second.db.distribution.peers.get(object), [])
    second.server.cluster.emit('peerDisconnected', { nodeId: 'one' })
    await settle()
    assert.deepEqual(second.db.distribution.peers.listPartitions(), [])
})
