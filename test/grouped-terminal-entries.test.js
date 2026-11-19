import assert from 'node:assert/strict'
import test from 'node:test'
import { createIndex } from '../src/index.js'
import { splitSerializedPartition } from '../src/partition.js'
import { enableMemoryCache, memoryEntries, removeMemoryPath } from '../src/memory.js'

const collect = async iterable => {
    const entries = []
    for await (const entry of iterable) entries.push(entry)
    return entries
}

test('terminal leaves group equal values and keep UUIDs sorted through insert and delete', async t => {
    const directory = `/tmp/coc-grouped-index-${process.pid}-${Math.random()}`
    enableMemoryCache(directory, { memoryOnly: true })
    const index = createIndex({ directory })
    t.after(() => removeMemoryPath(directory))

    for (const id of ['uuid-c', 'uuid-a', 'uuid-b']) await index.create('db', 'items', 'rank', 20, id)
    await index.create('db', 'items', 'rank', 21, 'uuid-d')

    const { indexes } = await index.read('db', 'items', 'rank')
    assert.deepEqual(indexes.number.entries, [[20, ['uuid-a', 'uuid-b', 'uuid-c']], [21, ['uuid-d']]])
    assert.equal(indexes.number.length, 4)
    assert.deepEqual(await collect(index.scan('db', 'items', 'rank', { type: 'number', lower: 20, upper: 20 })), [
        { value: 20, objectId: 'uuid-a' },
        { value: 20, objectId: 'uuid-b' },
        { value: 20, objectId: 'uuid-c' }
    ])

    await index.create('db', 'items', 'rank', 20, 'uuid-b')
    assert.equal((await index.read('db', 'items', 'rank')).indexes.number.length, 4, 'duplicate UUID is ignored')
    await index.delete('db', 'items', 'rank', 20, 'uuid-b')
    assert.deepEqual((await index.read('db', 'items', 'rank')).indexes.number.entries[0], [20, ['uuid-a', 'uuid-c']])
    await index.delete('db', 'items', 'rank', 20, 'uuid-a')
    await index.delete('db', 'items', 'rank', 20, 'uuid-c')
    assert.deepEqual((await index.read('db', 'items', 'rank')).indexes.number.entries, [[21, ['uuid-d']]])
})

test('forward, reverse, bounded and open scans retain duplicate ordering', async t => {
    const directory = `/tmp/coc-grouped-index-${process.pid}-${Math.random()}`
    enableMemoryCache(directory, { memoryOnly: true })
    const index = createIndex({ directory })
    t.after(() => removeMemoryPath(directory))

    const source = [[1, 'a'], [1, 'c'], [2, 'b'], [2, 'd'], [3, 'e']]
    for (const [value, id] of source) await index.create('db', 'items', 'rank', value, id)
    const read = options => collect(index.scan('db', 'items', 'rank', { type: 'number', ...options }))
    assert.deepEqual((await read({})).map(({ value, objectId }) => `${value}:${objectId}`), ['1:a', '1:c', '2:b', '2:d', '3:e'])
    assert.deepEqual((await read({ reverse: true })).map(({ value, objectId }) => `${value}:${objectId}`), ['3:e', '2:d', '2:b', '1:c', '1:a'])
    assert.deepEqual((await read({ lower: 2, upper: 2 })).map(({ objectId }) => objectId), ['b', 'd'])
    assert.deepEqual((await read({ lower: 1, upper: 3, lowerOpen: true, upperOpen: true })).map(({ objectId }) => objectId), ['b', 'd'])
})

test('oversized duplicate groups split across segments without losing or reordering UUIDs', async t => {
    const directory = `/tmp/coc-grouped-split-${process.pid}-${Math.random()}`
    enableMemoryCache(directory, { memoryOnly: true })
    const pending = new Map()
    const index = createIndex({ directory, maxBytes: 512, onPartitionChange: change => {
        if (!change.acquired) pending.set(change.path, change)
    } })
    t.after(() => removeMemoryPath(directory))

    const ids = Array.from({ length: 160 }, (_, i) => `uuid-${String(i).padStart(4, '0')}`)
    for (const id of ids) await index.create('db', 'items', 'rank', 7, id)
    let turns = 0
    while (pending.size) {
        assert.ok(++turns < 1000, 'replication splitting terminates')
        const [path, change] = pending.entries().next().value
        pending.delete(path)
        const split = await splitSerializedPartition(change.value, Buffer.byteLength(JSON.stringify(change.value)))
        if (split) for (const partition of split.partitions)
            pending.set(partition.path, { ...partition, operation: 'set' })
    }

    const tree = await index.read('db', 'items', 'rank')
    const leaves = [...memoryEntries(directory)].map(([, artifact]) => artifact)
        .filter(artifact => artifact?.entries?.[0]?.[0] === 7 && artifact?.kind !== 'catalog')
    assert.ok(tree.indexes.number.indexes, 'large duplicate group was split into internal segments')
    assert.ok(leaves.length > 1)
    assert.equal(leaves.reduce((count, leaf) => {
        const uuids = leaf.entries.flatMap(([, group]) => group)
        assert.equal(leaf.length, uuids.length)
        assert.deepEqual([leaf.firstValue, leaf.firstUuid], [leaf.entries[0][0], leaf.entries[0][1][0]])
        const last = leaf.entries.at(-1)
        assert.deepEqual([leaf.lastValue, leaf.lastUuid], [last[0], last[1].at(-1)])
        return count + uuids.length
    }, 0), ids.length)

    const forward = await collect(index.scan('db', 'items', 'rank', { type: 'number', lower: 7, upper: 7 }))
    const reverse = await collect(index.scan('db', 'items', 'rank', { type: 'number', lower: 7, upper: 7, reverse: true }))
    assert.deepEqual(forward.map(entry => entry.objectId), ids)
    assert.deepEqual(reverse.map(entry => entry.objectId), ids.toReversed())

    await index.create('db', 'items', 'rank', 7, 'uuid-0032a')
    const withInsert = await collect(index.scan('db', 'items', 'rank', { type: 'number', lower: 7, upper: 7 }))
    assert.deepEqual(withInsert.map(entry => entry.objectId), [...ids.slice(0, 33), 'uuid-0032a', ...ids.slice(33)])
    assert.equal(await index.delete('db', 'items', 'rank', 7, 'uuid-0032'), true)
})
