import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { queryData } from '@cocreate/utils'
import { fileId } from '../src/files.js'
import { createDB } from '../src/object/index.js'
import { flattenIndexValues } from '../src/storage.js'
import { removeMemoryPath } from '../src/memory.js'

const fixture = async run => {
    const directory = await mkdtemp(join(tmpdir(), 'cocreate-operators-'))
    try { await run(directory) }
    finally { removeMemoryPath(directory); await rm(directory, { recursive: true, force: true }) }
}
const body = object => Object.fromEntries(Object.entries(object).filter(([key]) =>
    !['_id', 'created', 'updated'].includes(key) && !key.startsWith('$')))
const id = value => value.toString(16).padStart(24, '0')

const values = [null, false, true, -2, 0, 2, 8, '2', 'Alpha', 'beta', '20', '', [],
    [1, 2], [1, 9], [{ x: 1 }], [null, 2], [[1, 2]], {}, { x: 1 }]
const documents = values.map((v, i) => ({ _id: id(i + 1), v, rank: i, group: i % 2 ? 'odd' : 'even' }))
documents.push({ _id: id(100), rank: 100, group: 'missing' })
documents.push({ _id: id(101), v: [{ x: [1, 2] }, { x: [3] }], rank: 101, group: 'nested' })

const queryCases = [
    ['eq', { v: { $eq: 2 } }], ['ne', { v: { $ne: 2 } }],
    ['eq null', { v: null }], ['eq missing', { missing: undefined }],
    ['not', { v: { $not: { $gt: 2 } } }],
    ['lt', { v: { $lt: 2 } }], ['lte', { v: { $lte: 2 } }],
    ['gt', { v: { $gt: 2 } }], ['gte', { v: { $gte: 2 } }],
    ['native string range mixed objects', { v: { $gt: 'A' } }],
    ['native object range', { v: { $gte: {} } }],
    ['in scalar', { v: { $in: false } }], ['in mixed', { v: { $in: [null, 2, '2', false] } }],
    ['nin', { v: { $nin: [2, null] } }], ['empty in', { v: { $in: [] } }],
    ['in nested array', { v: { $in: [[1, 2]] } }], ['nin nested array', { v: { $nin: [[1, 2]] } }],
    ['literal array', { v: [1, 2] }], ['eq array', { v: { $eq: [1, 2] } }],
    ['all', { v: { $all: [1, 2] } }], ['empty all', { v: { $all: [] } }],
    ['elemMatch scalar', { v: { $elemMatch: { $gt: 5, $lt: 10 } } }],
    ['elemMatch object', { v: { $elemMatch: { x: 1 } } }],
    ['size zero', { v: { $size: 0 } }], ['size two', { v: { $size: 2 } }],
    ['exists', { v: { $exists: true } }], ['missing', { v: { $exists: false } }],
    ['regex options', { v: { $regex: '^alpha$', $options: 'i' } }],
    ['regex global', { v: { $regex: /a/g } }],
    ['type object', { v: { $type: 'object' } }], ['type array', { v: { $type: 'array' } }],
    ['type choices', { v: { $type: ['array', 'number'] } }],
    ...['number', 'string', 'boolean', 'null', 'bool', 'int', 'long', 'double', 'decimal'].map(type => [`type ${type}`, { v: { $type: type } }]),
    ['mod', { v: { $mod: [2, 0] } }], ['invalid mod', { v: { $mod: [0, 0] } }],
    ['where', { $where() { return this.rank % 2 === 0 } }],
    ['and', { $and: [{ v: { $gte: 0 } }, { group: 'even' }] }],
    ['or', { $or: [{ group: 'missing' }, { v: 2 }] }],
    ['nor', { $nor: [{ v: { $type: 'array' } }, { group: 'odd' }] }],
    ['nested logical operators', { $and: [{ $or: [{ group: 'even' }, { group: 'nested' }] }, { v: { $not: { $size: 0 } } }] }],
    ['empty and', { $and: [] }], ['empty or', { $or: [] }], ['empty nor', { $nor: [] }],
    ['dotted array leaves', { 'v.x': 2 }], ['dotted array size', { 'v.x': { $size: 1 } }],
    ['dotted array all', { 'v.x': { $all: [1, 2] } }], ['dotted negative', { 'v.x': { $ne: 2 } }],
    ['bracket path', { 'v[0].x': 1 }], ['nested object', { v: { x: 1 } }],
    ['unknown operator', { v: { $unknown: 1 } }],
    ['id range', { _id: { $gt: id(3), $lte: id(8) } }]
]

for (const { memoryCache, writeBehind = false } of [{ memoryCache: false }, { memoryCache: true }, { memoryCache: true, writeBehind: true }]) {
    test(`DB query operator parity with memoryCache=${memoryCache}, writeBehind=${writeBehind}`, async t => {
        await fixture(async directory => {
            const db = createDB({ directory, memoryCache, writeBehind, scheduleIndexing: () => {}, maxIndexBytes: 1024 })
            try {
                const created = await db.send({ method: 'object.create', database: 'selectors', array: 'queries', object: documents })
                assert.equal(created.success, true, created.error)
                for (const [name, query] of queryCases) {
                    await t.test(name, async () => {
                        const expected = documents.filter(document => queryData(document, query)).map(document => document._id).sort()
                        const result = await db.send({ method: 'object.read', database: 'selectors', array: 'queries', filter: { query } })
                        assert.equal(result.success, true, result.error)
                        assert.deepEqual(result.object.map(document => document._id).sort(), expected)
                        assert.equal(result.filter.storages[0].count, expected.length)
                    })
                }
            } finally { await db.close() }
        })
    })
}

const updateCases = [
    ['set', { $set: { score: 7 } }, { score: 7, tags: [1, 2], old: 'before' }],
    ['set literal', { $set: { text: '$pop' } }, { score: 1, tags: [1, 2], old: 'before', text: '$pop' }],
    ['set bracket replacement', { $set: { 'tags[1]': 3 } }, { score: 1, tags: [1, 3], old: 'before' }],
    ['inc', { $inc: { score: 2 } }, { score: 3, tags: [1, 2], old: 'before' }],
    ['rename', { $rename: { old: 'profile.name' } }, { score: 1, tags: [1, 2], profile: { name: 'before' } }],
    ['push', { $push: { tags: 3 } }, { score: 1, tags: [1, 2, 3], old: 'before' }],
    ['each', { $each: { tags: [3, 4] } }, { score: 1, tags: [1, 2, 3, 4], old: 'before' }],
    ['each missing', { $each: { extra: [3, 4] } }, { score: 1, tags: [1, 2], old: 'before', extra: [3, 4] }],
    ['splice', { '$splice.tags[1]': 3 }, { score: 1, tags: [1, 3, 2], old: 'before' }],
    ['unset', { $unset: { old: true } }, { score: 1, tags: [1, 2] }],
    ['delete', { $delete: { old: true } }, { score: 1, tags: [1, 2] }],
    ['slice', { '$slice.tags[0]': true }, { score: 1, tags: [2], old: 'before' }],
    ['pop', { $pop: { tags: true } }, { score: 1, tags: [1], old: 'before' }],
    ['shift', { $shift: { tags: true } }, { score: 1, tags: [2], old: 'before' }],
    ['addToSet', { $addToSet: { tags: 2 } }, { score: 1, tags: [1, 2], old: 'before' }],
    ['pull', { $pull: { tags: 2 } }, { score: 1, tags: [1], old: 'before' }],
    ['bracket append', { 'tags[]': 3 }, { score: 1, tags: [1, 2, 3], old: 'before' }],
    ['global increment', {}, { score: 3, tags: [1, 2], old: 'before' }, { $inc: { score: 2 } }]
]

for (const { memoryCache, writeBehind = false } of [{ memoryCache: false }, { memoryCache: true }, { memoryCache: true, writeBehind: true }]) {
    test(`DB update values, indexes, and persistence with memoryCache=${memoryCache}, writeBehind=${writeBehind}`, async t => {
        await fixture(async directory => {
            let db = createDB({ directory, memoryCache, writeBehind, scheduleIndexing: () => {} })
            try {
                const initial = { score: 1, tags: [1, 2], old: 'before' }
                for (const [name, mutation, expected, globals = {}] of updateCases) {
                    await t.test(name, async () => {
                        const created = await db.send({ method: 'object.create', database: 'selectors', array: 'updates', object: structuredClone(initial) })
                        assert.equal(created.success, true, created.error)
                        const objectId = created.object[0]._id
                        const uuid = fileId(created.object[0])
                        const updated = await db.send({ method: 'object.update', database: 'selectors', array: 'updates', object: { _id: objectId, ...structuredClone(mutation) }, ...globals })
                        assert.equal(updated.success, true, updated.error)
                        assert.deepEqual(body(updated.object[0]), expected)
                        await db.flush()
                        const before = flattenIndexValues(initial)
                        const after = flattenIndexValues(expected)
                        const keys = new Set([...before, ...after].map(([key]) => key))
                        for (const key of keys) {
                            const actual = []
                            for await (const entry of db.index.scan('selectors', 'updates', key)) actual.push([entry.value, entry.objectId])
                            assert.deepEqual(actual, after.filter(([path]) => path === key).map(([, value]) => [value, uuid]), key)
                        }
                        await db.close()
                        removeMemoryPath(directory)
                        db = createDB({ directory, memoryCache, writeBehind, scheduleIndexing: () => {} })
                        const read = await db.send({ method: 'object.read', database: 'selectors', array: 'updates', object: { _id: objectId } })
                        assert.equal(read.success, true, read.error)
                        assert.deepEqual(body(read.object[0]), expected)
                        const deleted = await db.send({ method: 'object.delete', database: 'selectors', array: 'updates', object: { _id: objectId } })
                        assert.equal(deleted.success, true, deleted.error)
                    })
                }
                const made = await db.send({ method: 'object.create', database: 'selectors', array: 'updates', object: structuredClone(initial) })
                const objectId = made.object[0]._id
                for (const request of [
                    { object: { _id: objectId, $inc: { score: 'bad' } } },
                    { object: { _id: objectId, $unknown: { score: 2 } } },
                    { object: { _id: objectId }, $set: { _id: id(200) } },
                    { object: { _id: objectId }, $set: { '__proto__.polluted': true } },
                    { object: { _id: objectId }, $rename: { old: '_id' } }
                ]) {
                    const result = await db.send({ method: 'object.update', database: 'selectors', array: 'updates', ...request })
                    assert.equal(result.success, false)
                    const read = await db.send({ method: 'object.read', database: 'selectors', array: 'updates', object: { _id: objectId } })
                    assert.deepEqual(body(read.object[0]), initial)
                    assert.equal({}.polluted, undefined)
                }
            } finally { await db.close() }
        })
    })
}

test('logical and CoCreate selector filters update only matches and remove stale query entries', async () => {
    await fixture(async directory => {
        const db = createDB({ directory, memoryCache: true })
        const input = [
            { _id: id(201), team: 'a', score: 1, tags: [] },
            { _id: id(202), team: 'a', score: 2, tags: [] },
            { _id: id(203), team: 'b', score: 3, tags: [] },
            { _id: id(204), team: 'b', score: 4, tags: [] }
        ]
        const created = await db.send({ method: 'object.create', database: 'selectors', array: 'filtered', object: input })
        assert.equal(created.success, true, created.error)
        const update = await db.send({
            method: 'object.update', database: 'selectors', array: 'filtered',
            filter: { query: { $and: [{ team: 'a' }, { $or: [{ score: 1 }, { score: { $gte: 2 } }] }] } },
            object: { $inc: { score: 10 }, $push: { tags: 'changed' } }
        })
        assert.equal(update.success, true, update.error)
        assert.deepEqual(update.object.map(object => object._id).sort(), [id(201), id(202)])
        const again = await db.send({
            method: 'object.update', database: 'selectors', array: 'filtered',
            filter: { query: [{ key: 'team', value: 'a' }, { key: 'score', operator: '$gte', value: 11 }] },
            object: { $inc: { score: 1 } }
        })
        assert.equal(again.success, true, again.error)
        assert.equal(again.object.length, 2)
        const all = await db.send({ method: 'object.read', database: 'selectors', array: 'filtered' })
        const byId = new Map(all.object.map(object => [object._id, body(object)]))
        assert.deepEqual(byId.get(id(201)), { team: 'a', score: 12, tags: ['changed'] })
        assert.deepEqual(byId.get(id(202)), { team: 'a', score: 13, tags: ['changed'] })
        assert.deepEqual(byId.get(id(203)), { team: 'b', score: 3, tags: [] })
        const stale = await db.send({ method: 'object.read', database: 'selectors', array: 'filtered', filter: { query: { score: { $in: [1, 2, 11] } } } })
        assert.deepEqual(stale.object, [])
        const deleted = await db.send({ method: 'object.delete', database: 'selectors', array: 'filtered', filter: { query: { $nor: [{ team: 'a' }, { score: { $lt: 4 } }] } } })
        assert.equal(deleted.success, true, deleted.error)
        assert.deepEqual(deleted.object.map(object => object._id), [id(204)])
        assert.equal((await db.index.getMetadata('selectors', 'filtered', '_id')).indexes.string.length, 3)
        const remaining = await db.send({ method: 'object.read', database: 'selectors', array: 'filtered', filter: { query: { score: 4 } } })
        assert.deepEqual(remaining.object, [])
    })
})
