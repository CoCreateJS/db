import test from 'node:test'
import assert from 'node:assert/strict'
import { createIndex } from '../src/index/index.js'
import { splitSerializedPartition } from '../src/partition.js'
import { enableMemoryCache, memoryEntries, removeMemoryPath } from '../src/memory.js'
import { EventEmitter } from 'node:events'
import { initializeServerDB } from '../src/server.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const collect = async iterable => { const values = []; for await (const value of iterable) values.push(value); return values }
function fixture(t, maxBytes = 1024) {
    const directory = `/tmp/coc-send-split-${process.pid}-${Math.random()}`
    enableMemoryCache(directory, { memoryOnly: true })
    const pending = new Map(), sent = []
    const index = createIndex({ directory, maxBytes, onPartitionChange: change => {
        if (!change.acquired) pending.set(change.path, change)
    } })
    t.after(() => removeMemoryPath(directory))
    const drain = async () => {
        let steps = 0
        while (pending.size) {
            assert.ok(++steps < 10000, 'splitting must terminate')
            const [path, change] = pending.entries().next().value
            pending.delete(path)
            const encoded = JSON.stringify(change)
            const changes = change.operation === 'set' && await splitSerializedPartition(change.value, Buffer.byteLength(JSON.stringify(change.value)))
            if (changes) for (const part of changes.partitions) pending.set(part.path, { ...part, operation: 'set' })
            else sent.push(encoded)
        }
    }
    return { index, directory, sent, drain }
}

test('mutations do not measure or split; replication encoding splits live nodes and fixes ancestors', async t => {
    const { index, drain, sent } = fixture(t)
    const originalStringify = JSON.stringify
    JSON.stringify = () => { throw Error('Unexpected serialization in scalar index mutations') }
    try {
        for (let i = 0; i < 120; i++) await index.create('db', 'items', 'rank', i, `object-${i}`)
    } finally { JSON.stringify = originalStringify }
    const original = (await index.read('db', 'items', 'rank')).indexes.number
    assert.equal(original.entries.length, 120)
    await drain()
    const root = (await index.read('db', 'items', 'rank')).indexes.number
    assert.ok(root.indexes)
    assert.ok(original.entries.length < 120)
    const rows = await collect(index.scan('db', 'items', 'rank', { type: 'number' }))
    assert.deepEqual(rows.map(row => row.value), Array.from({ length: 120 }, (_, i) => i))
    assert.equal(root.length, 120)
    for (const encoded of sent) {
        const node = JSON.parse(encoded).value
        if (node) { assert.equal('bytes' in node, false); assert.equal('size' in node, false) }
    }
    for (let i = 0; i < 120; i++) await index.delete('db', 'items', 'rank', i, `object-${i}`)
    await drain()
    assert.deepEqual((await index.read('db', 'items', 'rank')).indexes, {})
})

test('catalog splitting happens only on serialization and keeps metadata and ordered lookups correct', async t => {
    const { index, drain, directory } = fixture(t, 1024)
    for (let i = 0; i < 80; i++) await index.create('db', 'items', `key-${String(i).padStart(3, '0')}`, i, 'one')
    const catalog = memoryEntries(directory).find(([, node]) => node.kind === 'catalog' && node.id === node.catalog)[1]
    assert.equal(catalog.entries.length, 80)
    await drain()
    assert.ok(catalog.indexes)
    assert.equal(catalog.catalogLength, 80)
    for (let i = 0; i < 80; i++) {
        const key = `key-${String(i).padStart(3, '0')}`
        const [row] = await collect(index.scan('db', 'items', key, { type: 'number' }))
        assert.equal(row.value, i)
        assert.equal((await index.getMetadata('db', 'items', key)).indexes.number.length, 1)
    }
})

test('a 300 KiB indivisible entry is sent without an error or endless splitting', async t => {
    const { index, drain, sent } = fixture(t, 128 * 1024)
    await index.create('db', 'files', 'source', 'x'.repeat(300 * 1024), 'large')
    await index.create('db', 'files', 'source', 'small', 'small')
    await drain()
    assert.ok(sent.some(encoded => Buffer.byteLength(encoded) > 128 * 1024))
    const rows = await collect(index.scan('db', 'files', 'source', { type: 'string' }))
    assert.equal(rows.length, 2)
    assert.equal(rows.find(row => row.objectId === 'large').value.length, 300 * 1024)
    assert.equal((await index.read('db', 'files', 'source')).indexes.string.indexes.length, 2)
})

test('a cold direct partition send reconstructs its ancestry before splitting', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'coc-cold-send-'))
    t.after(async () => { await rm(directory, { recursive: true, force: true }) })
    const original = createIndex({ directory, maxBytes: 1024 })
    for (let i = 0; i < 80; i++) await original.create('db', 'items', 'rank', i, `object-${i}`)
    const path = await original.locatePartition('db', 'items', 'rank', 20, 'object-20')
    const reopened = createIndex({ directory, maxBytes: 1024 })
    const node = await reopened.readPartition(path)
    const changed = await splitSerializedPartition(node, Buffer.byteLength(JSON.stringify(node)))
    assert.ok(changed.partitions.length >= 3)
    assert.ok((await reopened.read('db', 'items', 'rank')).indexes.number.indexes)
    assert.equal((await collect(reopened.scan('db', 'items', 'rank', { type: 'number' }))).length, 80)
})

test('primary sends scoped split siblings and parent updates using the prepared encoding', async t => {
    const directory = `/tmp/coc-primary-split-${process.pid}-${Math.random()}`
    const frames = []
    const server = Object.assign(new EventEmitter(), { id: 'primary', isPrimary: true,
        cluster: Object.assign(new EventEmitter(), { send: (payload, encoded) => {
            if (payload.method === 'db.partition.update') {
                assert.equal(typeof encoded, 'string')
                frames.push(JSON.parse(encoded))
            }
        } }), send: async payload => payload })
    const db = initializeServerDB(server, { directory, memoryOnly: true, maxIndexBytes: 2048 })
    t.after(async () => { await db.close(); removeMemoryPath(directory) })
    const scope = { organization_id: '000000000000000000000001', storage: 'dev', database: 'app', array: 'items' }
    const documents = Array.from({ length: 50 }, (_, i) => ({ rank: i, pathname: `${'long-path/'.repeat(12)}${i}` }))
    const created = await db.send({ ...scope, method: 'object.create', object: documents })
    assert.equal(created.success, true, created.error)
    await db.flush()
    const held = await db.listPartitions()
    for (const { partitionId } of held) await db.updatePartition({ partitionId, nodeId: 'peer', operation: 'add' })
    const updated = await db.send({ ...scope, method: 'object.update', object: { _id: created.object[0]._id, rank: 100, pathname: 'changed' } })
    assert.equal(updated.success, true, updated.error)
    await db.flush()
    assert.ok(frames.length)
    const final = new Map(frames.filter(frame => frame.operation === 'set').map(frame => [frame.path, frame.value]))
    const oldPaths = new Set(held.map(item => item.partitionId))
    assert.ok([...final.keys()].some(path => !oldPaths.has(path)), 'new siblings are delivered to the original holder')
    for (const [path, value] of final) {
        assert.ok(path.startsWith(`${scope.organization_id}/indexes/`), path)
        assert.equal(JSON.stringify(value), JSON.stringify(await db.readIndexPartition(path)))
    }
    const read = await db.send({ ...scope, method: 'object.read', filter: { query: { rank: 100 } } })
    assert.equal(read.object[0]._id, created.object[0]._id)
})
