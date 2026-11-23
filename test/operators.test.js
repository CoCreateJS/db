import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LeafTier } from '../src/tree/leaves.js'
import { LocalTier } from '../src/tree/local.js'
import { queryData } from '@cocreate/utils'
import { createLeaf, attach, updateLeaf, type } from '../src/leaf.js'
import { Tree } from '../src/tree/index.js'
import { queryTree } from '../src/tree/query.js'

async function indexedRoot(records, leaves = new Map()) {
    const root = { leaves, tree: new Map() }
    for (const record of records) {
        const leaf = createLeaf(structuredClone(record))
        root.leaves.set(leaf.uuid, leaf)
        await attach(leaf, entry => {
            let types = root.tree.get(entry.key)
            if (!types) root.tree.set(entry.key, types = new Map())
            let tree = types.get(type(entry.value))
            if (!tree) types.set(type(entry.value), tree = new Tree(3))
            return tree.insert(entry)
        })
    }
    return root
}

test('leaf creation omits undefined values and indexes null', async () => {
    const leaf = createLeaf({ uuid: 'a', value: undefined, nested: { missing: undefined, nil: null } })
    assert.equal(Object.hasOwn(leaf, 'value'), false)
    assert.equal(Object.hasOwn(leaf.nested, 'missing'), false)
    assert.equal((await leaf.getIndex('nested.nil'))?.value, null)
})

test('leaf updates remove undefined indexes and move type-changed entries', async () => {
    const root = await indexedRoot([{ uuid: 'a', value: 2 }])
    const leaf = root.leaves.get('a')
    const entry = await leaf.getIndex('value')
    const numberTree = root.tree.get('value').get('number')
    assert.equal(entry.index !== null, true)

    await updateLeaf(leaf, { value: '2' })
    assert.equal(await leaf.getIndex('value'), entry)
    assert.equal(entry.value, '2')
    assert.equal(entry.tree, root.tree.get('value').get('string'))
    assert.equal(numberTree.root.length, 0)

    await updateLeaf(leaf, { value: undefined })
    assert.equal(Object.hasOwn(leaf, 'value'), false)
    assert.equal(await leaf.getIndex('value'), undefined)
    assert.equal(entry.index, null)
})

test('indexed and full-scan query results match Utils semantics', async () => {
    const root = await indexedRoot([
        { uuid: 'a', value: 2, data: { x: 1 }, rows: [{ n: 4 }] },
        { uuid: 'b', value: '2', data: { x: 2 }, rows: [{ n: 5 }] },
        { uuid: 'c', value: [2], data: { x: 3 }, rows: [{ n: 6 }] },
        { uuid: 'd', value: 4, data: { x: 4 }, rows: [{ n: 7 }] },
        { uuid: 'e', value: null, data: { x: 5 }, rows: [] }
    ])
    const queries = [
        { value: 2 },
        { value: { $in: [2, [2]] } },
        { value: { $includes: 2 } },
        { value: { $gte: 2, $lt: 4 } },
        { value: { $gte: '1', $lt: 5 } },
        { value: { $ne: 2 } },
        { 'data.x': { $gt: 2 } },
        { 'rows[0].n': { $gte: 5 } },
        { 'rows.n': 5 },
        { $or: [{ value: 2 }, { value: '2' }] },
        { value: { $exists: true } }
    ]

    for (const query of queries) {
        const expected = [...root.leaves.values()].filter(leaf => queryData(leaf, query))
            .map(leaf => leaf.uuid).sort()
        const actual = (await queryTree(root, query)).map(leaf => leaf.uuid).sort()
        assert.deepEqual(actual, expected, JSON.stringify(query))
    }
})

test('ranges match numeric strings and unindexed arrays even when a numeric index exists', async () => {
    const root = await indexedRoot([
        { uuid: 'number', score: 20, active: true },
        { uuid: 'string', score: '20', active: true },
        { uuid: 'array', score: [20], active: true },
        { uuid: 'low', score: 5, active: true },
        { uuid: 'inactive', score: '30', active: false }
    ])
    assert.deepEqual((await queryTree(root, { score: { $gt: 10 } })).map(o => o.uuid).sort(),
        ['array', 'inactive', 'number', 'string'])
    assert.deepEqual((await queryTree(root, { active: true, score: { $gt: 10 } })).map(o => o.uuid).sort(),
        ['array', 'number', 'string'])
})

test('range coverage counts warm leaves and skips warm entries outside the bounds', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'cocreatedb-range-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const local = await new LocalTier(directory).initialize()
    const leaves = new LeafTier(local)
    const root = await indexedRoot([
        { uuid: 'number', root: 'object', score: 15 },
        { uuid: 'unrelated', root: 'object', score: 50 },
        { uuid: 'warm', root: 'object', score: '15' }
    ], leaves)
    const warm = await leaves.get('warm')
    const unrelated = await leaves.get('unrelated')
    const query = { score: { $gte: 10, $lt: 20 } }
    assert.equal(await warm.toDisk(), true)
    assert.equal(leaves.size, root.tree.get('score').get('number').root.length)
    assert.equal(leaves.totalSize, 3)
    assert.equal(leaves.warm instanceof Map, false)
    const matches = await queryTree(root, query)
    assert.deepEqual(matches.map(object => object.uuid), ['number', 'warm'])
    assert.notEqual(matches[1], warm)
    assert.equal(await matches[1].getValue('score'), '15')

    assert.equal(await (await leaves.get('warm')).toDisk(), true)
    assert.equal(await unrelated.toDisk(), true)
    const reads = leaves.reads
    assert.deepEqual((await queryTree(root, query)).map(object => object.uuid), ['number', 'warm'])
    assert.equal(leaves.reads - reads, 1)
    assert.equal(leaves.warm.has('unrelated'), true)
})

test('pending deletes cannot make a range index appear to cover every leaf', async () => {
    const root = await indexedRoot([
        { uuid: 'number', score: 15 },
        { uuid: 'deleted', score: 16 },
        { uuid: 'string', score: '17' }
    ])
    const deleted = await root.leaves.get('deleted')
    root.leaves.delete('deleted')
    root.pendingIndex = new Set([deleted])
    assert.equal(root.leaves.size, root.tree.get('score').get('number').root.length)
    assert.deepEqual((await queryTree(root, { score: { $gte: 10, $lt: 20 } })).map(object => object.uuid),
        ['number', 'string'])
})
