import assert from 'node:assert/strict'
import test from 'node:test'
import { stringifyValue, parseValue } from '../src/codec.js'
import { createIndex } from '../src/index/index.js'
import { createObject } from '../src/object/initialize.js'
import { queryIndexCandidates } from '../src/query.js'
import { splitSerializedPartition } from '../src/partition.js'

const uuid = '1123456789abcdef0123456789abcdef'

test('index construction reuses live entries and persists UUID-only terminal values', async t => {
    const directory = `/tmp/coc-live-index-${process.pid}-${Math.random()}`
    const artifacts = new Map()
    const index = createIndex({ directory, artifacts, maxBytes: 4096 })
    t.after(async () => { await index.drop('db', 'items'); artifacts.clear() })

    const first = createObject({ _id: 'first', score: 4, tags: ['x', 'y'], profile: { city: 'Lima' } }, { uuid, artifacts })
    const second = createObject({ _id: 'second', score: 4, tags: ['x', 'y'], profile: { city: 'Quito' } }, {
        uuid: '2123456789abcdef0123456789abcdef', artifacts
    })

    for (const object of [first, second])
        for (const key in object.getIndex()) {
            const entry = object.getIndex(key)
            await index.create('db', 'items', entry.key, entry.value, object.uuid, entry)
        }

    assert.strictEqual(artifacts.get(uuid), first)
    assert.strictEqual(first.getIndex('score'), first.getIndex('score'))
    const root = (await index.read('db', 'items', 'score')).indexes.number
    assert.equal(root.parent.kind, 'catalog')
    const group = root.entries.find(([value]) => value === 4)
    assert.deepEqual(group[1].map(entry => entry.uuid), [first.uuid, second.uuid].sort())
    for (const entry of group[1]) {
        assert.strictEqual(entry.object.getIndex('score'), entry)
        assert.strictEqual(entry.partition, root)
    }

    const persisted = parseValue(stringifyValue(root))
    assert.deepEqual(persisted.entries.find(([value]) => value === 4)[1], [first.uuid, second.uuid].sort())
    const scanned = []
    for await (const entry of index.scan('db', 'items', 'score', { type: 'number', lower: 4, upper: 4 }))
        scanned.push(entry.objectId)
    assert.deepEqual(scanned, [first.uuid, second.uuid].sort())

    const objectRefs = new Map()
    const candidates = await queryIndexCandidates(index, 'db', 'items', { score: 4 }, { objectRefs })
    assert.deepEqual([...candidates.ids].sort(), [first.uuid, second.uuid].sort())
    assert.strictEqual(objectRefs.get(first.uuid), first)
    assert.strictEqual(objectRefs.get(second.uuid), second)

    const groupedEntries = [...group[1]]
    await splitSerializedPartition(root, 4097)
    const partitions = new Set(groupedEntries.map(entry => entry.partition))
    assert.equal(partitions.size, 2)
    const [left, right] = partitions
    assert.strictEqual(left.parent, right.parent)
    assert.equal(left.parent.indexes.length, 2)
})
