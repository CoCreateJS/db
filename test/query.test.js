import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { queryData } from '@cocreate/utils'
import { createDB, createIndex } from '../src/index.js'
import { flattenIndexValues } from '../src/storage.js'
import { queryIndexCandidates } from '../src/query.js'

const fixture = async run => {
    const directory = await mkdtemp(join(tmpdir(), 'cocreate-query-'))
    try { await run(directory) }
    finally { await rm(directory, { recursive: true, force: true }) }
}

const seed = async (index, documents) => {
    for (const document of documents)
        for (const [key, value] of flattenIndexValues(document))
            await index.set('dev', 'items', key, value, document._id)
}

test('catalog statistics stay current through splits, duplicate insertion, deletion, and reopen', async () => {
    await fixture(async directory => {
        let index = createIndex({ directory, maxBytes: 512 })
        for (let value = 0; value < 40; value++) {
            await index.set('dev', 'items', 'rank', value, String(value))
            const { indexes } = await index.getMetadata('dev', 'items', 'rank')
            assert.equal(indexes.number.length, value + 1)
            assert.deepEqual(indexes.number.first, { value: 0, objectId: '0' })
            assert.deepEqual(indexes.number.last, { value, objectId: String(value) })
        }
        await index.set('dev', 'items', 'rank', 39, '39')
        assert.equal((await index.getMetadata('dev', 'items', 'rank')).indexes.number.length, 40)
        for (let value = 0; value < 40; value++) {
            await index.remove('dev', 'items', 'rank', value, String(value))
            const { indexes } = await index.getMetadata('dev', 'items', 'rank')
            if (value === 39) assert.deepEqual(indexes, {})
            else {
                assert.equal(indexes.number.length, 39 - value)
                assert.equal(indexes.number.first.value, value + 1)
                assert.equal(indexes.number.last.value, 39)
            }
        }
        await index.set('dev', 'items', 'rank', 7, '7')
        index = createIndex({ directory, maxBytes: 512 })
        const metadata = await index.getMetadata('dev', 'items', 'rank')
        assert.equal(metadata.indexes.number.length, 1)
        const catalog = JSON.parse(await readFile(join(directory, 'dev/items/index/index.json')))
        assert.deepEqual(catalog.entries[0][3], {
            length: 1, first: { value: 7, objectId: '7' }, last: { value: 7, objectId: '7' }
        })
        for (const file of await readdir(join(directory, 'dev/items/index'))) {
            const node = JSON.parse(await readFile(join(directory, 'dev/items/index', file)))
            assert.equal('count' in node, false)
            assert.equal('catalogCount' in node, false)
            for (const child of node.indexes ?? []) assert.equal('count' in child, false)
        }
        // Metadata is served from the catalog, without a value-root read.
        await rm(join(directory, 'dev/items/index', `${metadata.indexes.number.id}.json`))
        assert.deepEqual(await index.getMetadata('dev', 'items', 'rank'), metadata)
        for (const condition of [8, { $gt: 7 }, { $lt: 7 }]) {
            const result = await queryIndexCandidates(index, 'dev', 'items', { rank: condition })
            assert.equal(result.ids.size, 0)
            assert.equal(result.exact, true)
        }
    })
})

test('legacy recursive lengths and mappings remain readable and are upgraded on mutation', async () => {
    await fixture(async directory => {
        const index = createIndex({ directory, maxBytes: 512 })
        for (let value = 0; value < 30; value++) await index.set('dev', 'items', 'rank', value, String(value))
        const path = join(directory, 'dev/items/index')
        for (const file of await readdir(path)) {
            const node = JSON.parse(await readFile(join(path, file)))
            if (node.length !== undefined) { node.count = node.length; delete node.length }
            if (node.catalogLength !== undefined) { node.catalogCount = node.catalogLength; delete node.catalogLength }
            for (const child of node.indexes ?? []) { child.count = child.length; delete child.length }
            if (node.kind === 'catalog' && node.entries) node.entries = node.entries.map(entry => entry.slice(0, 3))
            await writeFile(join(path, file), JSON.stringify(node))
        }
        const reopened = createIndex({ directory, maxBytes: 512 })
        assert.equal((await reopened.getMetadata('dev', 'items', 'rank')).indexes.number.length, 30)
        await reopened.set('dev', 'items', 'rank', 30, '30')
        assert.equal((await reopened.getMetadata('dev', 'items', 'rank')).indexes.number.length, 31)
        const root = JSON.parse(await readFile(join(path, 'index.json')))
        assert.equal(root.entries[0][3].length, 31)
        assert.equal('count' in root, false)
    })
})

test('array operators and mixed dotted paths preserve shared query semantics, including negation', async () => {
    await fixture(async directory => {
        const documents = [
            { _id: '1', tags: ['red', 'blue'], n: 2, profile: { name: 'Bob' } },
            { _id: '2', tags: ['blue'], n: 3, profile: [{ name: 'Ada' }] },
            { _id: '3', tags: [['red', 'blue']], n: 4 },
            { _id: '4', tags: 'red', n: '5' },
            { _id: '5' }
        ]
        const index = createIndex({ directory })
        await seed(index, documents)
        const queries = [
            { tags: { $type: 'array' } }, { tags: { $not: { $type: 'array' } } },
            { $nor: [{ tags: { $type: 'array' } }] },
            { tags: { $all: ['red', 'blue'] } }, { tags: { $in: ['red'] } },
            { tags: { $nin: ['red'] } }, { tags: { $in: [['red', 'blue']] } },
            { tags: { $nin: [['red', 'blue']] } }, { tags: ['red', 'blue'] },
            { tags: { $eq: ['red', 'blue'] } }, { tags: { $ne: ['red', 'blue'] } },
            { tags: { $regex: '^red' } }, { n: { $mod: [2, 0] } },
            { n: { $type: 'number' } }, { n: { $gt: 2, $lte: 4 } },
            { 'profile.name': 'Ada' }, { 'profile.name': { $ne: 'Ada' } },
            { $or: [{ 'profile.name': 'Ada' }, { n: 2 }] },
            { $and: [{ $or: [{ n: 2 }, { n: 3 }] }, { tags: { $type: 'array' } }] }
        ]
        for (const query of queries) {
            const result = await queryIndexCandidates(index, 'dev', 'items', query)
            const expected = documents.filter(document => queryData(document, query)).map(document => document._id)
            const actual = documents.filter(document => result.ids.has(document._id) && queryData(document, query)).map(document => document._id)
            assert.deepEqual(actual, expected, JSON.stringify(query))
            if (result.exact) assert.deepEqual([...result.ids].sort(), [...expected].sort(), JSON.stringify(query))
        }
    })
})

test('planner uses catalog lengths before scanning and checks expensive OR predicates on narrowed documents', async () => {
    const calls = []
    const index = {
        getMetadata: async (_database, _array, key) => ({ indexes: {
            string: { length: key === 'small' ? 2 : 1000 }
        } }),
        get: () => { throw new Error('planner must use catalog metadata') },
        scan: async function* (_database, _array, key) {
            calls.push(key)
            if (key === 'small') yield { value: 'yes', objectId: '1' }
            else throw new Error(`Unexpected broad scan: ${key}`)
        }
    }
    const result = await queryIndexCandidates(index, 'dev', 'items', {
        broad: 'yes', $and: [{ small: 'yes' }, { $or: [{ other: 'yes' }, { another: 'yes' }] }]
    }, { readObject: async () => ({ _id: '1', broad: 'yes', small: 'yes', other: 'yes' }) })
    assert.deepEqual([...result.ids], ['1'])
    assert.deepEqual(calls, ['small'])
    calls.length = 0
    const noMatches = await queryIndexCandidates({ ...index, scan: async function* (_d, _a, key) { calls.push(key) } }, 'dev', 'items', {
        broad: 'yes', small: 'absent'
    })
    assert.equal(noMatches.ids.size, 0)
    assert.deepEqual(calls, ['small'])
})

test('_id is cataloged automatically and ID ranges reach bounded index scans', async () => {
    await fixture(async directory => {
        const db = createDB({ directory })
        const ids = [1, 2, 3].map(value => value.toString(16).padStart(24, '0'))
        const created = await db.send({ method: 'object.create', database: 'dev', array: 'items', object: ids.map(_id => ({ _id })) })
        assert.equal(created.success, true, created.error)
        const root = (await db.index.getMetadata('dev', 'items', '_id')).indexes.string
        assert.equal(root.length, 3)
        assert.equal(root.first.value, ids[0])
        assert.equal(root.last.value, ids[2])
        const response = await db.send({ method: 'object.read', database: 'dev', array: 'items', filter: {
            query: { _id: { $gt: ids[0], $lte: ids[1] } }
        } })
        assert.equal(response.success, true, response.error)
        assert.deepEqual(response.object.map(object => object._id), [ids[1]])
        assert.equal(response.filter.storages[0].count, 1)
        const options = []
        await queryIndexCandidates({
            getMetadata: async () => ({ indexes: { string: { length: 3 } } }),
            scan: async function* (_d, _a, key, range) { options.push({ key, ...range }); yield { value: ids[1], objectId: ids[1] } }
        }, 'dev', 'items', { _id: { $gt: ids[0], $lte: ids[1] } })
        assert.deepEqual(options, [
            { key: '_id', type: 'string', lower: ids[0], lowerOpen: true },
            { key: '_id', type: 'string', upper: ids[1], upperOpen: false }
        ])
    })
})

test('bounded leaf seeking preserves duplicate ties, open boundaries, reverse order, and limits', async () => {
    await fixture(async directory => {
        const index = createIndex({ directory, maxBytes: 512 })
        for (let i = 0; i < 50; i++)
            await index.set('dev', 'items', 'rank', Math.floor(i / 10), String(i).padStart(2, '0'))
        const collect = async options => {
            const entries = []
            for await (const entry of index.scan('dev', 'items', 'rank', { type: 'number', ...options })) entries.push(entry)
            return entries
        }
        const equal = await collect({ lower: 2, upper: 2 })
        assert.deepEqual(equal.map(entry => entry.objectId), Array.from({ length: 10 }, (_, i) => String(20 + i)))
        assert.deepEqual(await collect({ lower: 2, upper: 2, lowerOpen: true }), [])
        const bounded = await collect({ lower: 1, upper: 3, lowerOpen: true, upperOpen: true })
        assert.deepEqual(bounded, equal)
        assert.deepEqual(await collect({ lower: 2, upper: 2, reverse: true }), [...equal].reverse())
        assert.deepEqual(await collect({ lower: 2, upper: 2, reverse: true, limit: 1 }), [equal.at(-1)])
    })
})
