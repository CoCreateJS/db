import test from 'node:test'
import assert from 'node:assert/strict'
import { queryData, sortData, searchData } from '@cocreate/utils'
import { createTestTree } from '../test-support/tree.mjs'
import { leafPath, MemoryDisk } from '../test-support/memory-disk.mjs'
import { waitForIdle } from './benchmarks/shared/wait-for-index.mjs'

const scope = { storage: 'bench', database: 'app', array: 'items' }
async function fixture(count = 96) {
    const disk = new MemoryDisk()
    const tree = await createTestTree({ disk, size: 8, leafSize: 8 })
    const values = Array.from({ length: count }, (_, i) => ({
        uuid: `leaf-${String(i).padStart(4, '0')}`, rank: i, team: ['blue', 'red', 'green'][i % 3],
        score: i % 7, label: `name-${i % 11}`, active: i % 2 === 0,
        ...(i % 4 ? { optional: i % 5 === 0 ? null : i } : {}),
        mixed: [null, true, 2, '2', false, '10'][i % 6],
        profile: { city: i % 2 ? 'Lima' : 'Quito' }, tags: [i % 3, i % 2]
    }))
    const response = await tree.execute({ ...scope, method: 'object.create', object: values })
    assert.equal(response.success, true, response.error?.join('; '))
    await waitForIdle(tree)
    return { disk, tree, values, primary: response.object[0].parent }
}
const read = (tree, filter) => tree.execute({ ...scope, method: 'object.read', filter })
const ids = records => records.map(record => record.uuid)
function expected(values, filter) {
    const selected = values.filter(value => queryData(value, filter.query) && searchData(value, filter.search))
    sortData(selected, [...(filter.sort ?? []), { key: 'uuid', direction: 'asc' }])
    const start = filter.startingIndex ?? filter.index ?? 0
    return selected.slice(start, filter.limit ? start + filter.limit : undefined)
}

test('index algebra and multi-field pagination agree with Utils, hot and cold', async () => {
    const { tree, values, primary } = await fixture()
    const queries = [
        { team: 'blue', score: { $gte: 2, $lt: 6 } },
        { $and: [{ rank: { $gt: 20, $gte: 15 } }, { rank: { $lte: 70, $lt: 50 } }] },
        { $or: [{ team: 'red', score: 3 }, { rank: { $lt: 5 } }] },
        { $nor: [{ score: { $lt: 3 } }, { active: false }] },
        { rank: { $lt: 15, $eq: 20 } },
        { optional: { $exists: false } }, { optional: { $eq: null } },
        { mixed: { $gte: 2, $lt: 10 } }, { mixed: { $in: [true, 2, '2'] } },
        { team: { $not: { $in: ['blue', 'red'] } } },
        { tags: { $in: [1] } }, { tags: { $all: [1, 0] } },
        { 'tags.0': { $gte: 1 } }, { 'tags[0]': 1 },
        { profile: { city: 'Lima' } }, { 'profile.city': 'Quito' },
        { team: { $includes: 're' } }, { label: { $regex: '^name-[12]$', $options: 'i' } },
        { $or: [{ tags: { $size: 2 } }, { rank: 90 }] },
        { $and: [{ team: 'blue' }, { $where() { return this.rank % 2 === 0 } }] },
        { 'optional': { $nin: [null, 5] } }, { mixed: { $type: ['number', 'null'] } },
        { '.rank': { $gte: 80 } }, { uuid: { $in: ['leaf-0001', 'leaf-0002'] } },
        {}, { $or: [] }, { $and: [] }
    ]
    try {
        for (const cold of [false, true]) for (const query of queries) {
            if (cold) await tree.prune({ uuid: primary })
            const filter = { query, sort: [{ key: 'score', direction: 'desc' }, { key: 'label', direction: 'asc' }], index: 2, limit: 9 }
            const result = await read(tree, filter)
            assert.equal(result.success, true, result.error?.join('; '))
            assert.deepEqual(ids(result.object), ids(expected(values, filter)), `cold=${cold}; query=${JSON.stringify(query)}`)
            assert.equal(result.filter.startingIndex, 2)
            assert.equal(result.filter.index, 2 + result.object.length)
            assert.equal(tree.pendingIndexCount, 0, 'reads never queue indexing')
        }
        const all = { query: { active: true }, startingIndex: 4, index: 1, limit: 0, sort: [{ key: 'rank', direction: 'desc' }] }
        assert.deepEqual(ids((await read(tree, all)).object), ids(expected(values, all)))
    } finally { await tree.close() }
})

test('cold indexed query hydrates only the requested page and never writes or reindexes', async () => {
    const { tree, disk, values, primary } = await fixture(120)
    try {
        await tree.prune({ uuid: primary })
        const paths = new Set(values.map(value => leafPath(value.uuid)))
        const accessed = [], execute = disk.execute.bind(disk)
        disk.execute = async request => { accessed.push(request); return execute(request) }
        const filter = { query: { rank: { $gte: 90 }, team: 'blue' }, sort: [{ key: 'score', direction: 'desc' }, { key: 'rank', direction: 'asc' }], index: 1, limit: 3 }
        const result = await read(tree, filter)
        assert.equal(result.success, true, result.error?.join('; '))
        assert.deepEqual(ids(result.object), ids(expected(values, filter)))
        assert.equal(accessed.filter(request => request.operation === 'read' && paths.has(request.path)).length, 3)
        assert.equal(accessed.some(request => request.operation === 'write' || request.operation === 'delete'), false)
        assert.equal(tree.pendingIndexCount, 0)
        const unused = tree.config.indexes.filter(route => route.primary === primary && ['profile.city', 'optional', 'tags[0]', 'mixed'].includes(route.key))
        assert.ok(unused.every(route => !accessed.some(request => request.path === `branches/${route.uuid}.json`)))
    } finally { await tree.close() }
})

test('cold UUID reads leave the queue empty; later scalar updates and deletes keep stored indexes correct', async () => {
    const { tree, disk, primary, values } = await fixture(40)
    try {
        await tree.prune({ uuid: primary })
        const leaf = (await tree.execute({ ...scope, method: 'object.read', object: { uuid: values[3].uuid } })).object[0]
        assert.equal(tree.pendingIndexCount, 0)
        await leaf.setValue('rank', 500)
        await waitForIdle(tree)
        assert.equal((await read(tree, { query: { rank: 3 }, limit: 0 })).object.length, 0)
        assert.deepEqual(ids((await read(tree, { query: { rank: 500 }, limit: 0 })).object), [leaf.uuid])
        await tree.prune({ uuid: primary })
        const update = await tree.execute({ ...scope, method: 'object.update', object: { uuid: leaf.uuid, $update: { $set: { 'profile.city': 'Oslo' }, $unset: { optional: true }, $push: { tags: 9 } } } })
        assert.equal(update.success, true, update.error?.join('; '))
        await waitForIdle(tree)
        assert.equal((await read(tree, { query: { 'profile.city': 'Oslo' }, limit: 0 })).object.length, 1)
        assert.equal((await read(tree, { query: { 'profile.city': 'Lima', rank: 500 }, limit: 0 })).object.length, 0)
        await tree.prune({ uuid: primary })
        const deleted = await tree.execute({ ...scope, method: 'object.delete', object: { uuid: leaf.uuid } })
        assert.equal(deleted.success, true, deleted.error?.join('; '))
        await waitForIdle(tree)
        assert.equal((await read(tree, { query: { rank: 500 }, limit: 0 })).object.length, 0)
        assert.equal(disk.hasLeaf(leaf.uuid), false)
    } finally { await tree.close() }
})

test('active reads protect their primary Tree, concurrent counts release independently, and errors release pins', async () => {
    const { tree, disk, primary, values } = await fixture(32)
    const neighbor = (await tree.execute({ ...scope, array: 'neighbor', method: 'object.create', object: { rank: 0 } })).object[0]
    await waitForIdle(tree)
    await tree.prune({ uuid: primary })
    const targetPath = leafPath(values[0].uuid)
    let release, entered
    const gate = new Promise(resolve => { release = resolve })
    const started = new Promise(resolve => { entered = resolve })
    const execute = disk.execute.bind(disk)
    disk.execute = async request => {
        if (request.operation === 'read' && request.path === targetPath) { entered(); await gate }
        return execute(request)
    }
    const slow = tree.execute({ ...scope, method: 'object.read', object: { uuid: values[0].uuid } })
    try {
        await started
        // Another read can complete without clearing the first read's protection.
        const other = await tree.execute({ ...scope, method: 'object.read', object: { uuid: values[1].uuid } })
        assert.equal(other.success, true)
        assert.deepEqual(await tree.prune({ uuid: primary }), { count: 0 })
        assert.deepEqual(await tree.prune({ uuid: neighbor.parent }), { count: 1 })
        release()
        assert.equal((await slow).success, true)
        const invalid = await read(tree, { query: {}, index: -1, limit: 1 })
        assert.equal(invalid.success, false)
        assert.deepEqual(await tree.prune({ uuid: primary }), { count: 1 })
    } finally { release(); await slow; await tree.close() }
})

test('partially scoped plans retain root constraints and OR deduplicates before pagination', async () => {
    const { tree, values } = await fixture(12)
    try {
        await tree.execute({ ...scope, storage: 'other', method: 'object.create', object: { rank: 0, team: 'blue' } })
        await tree.execute({ ...scope, array: 'other', method: 'object.create', object: { rank: 0, team: 'blue' } })
        await waitForIdle(tree)
        const result = await tree.execute({ storage: scope.storage, method: 'object.read', filter: { query: { $or: [{ team: 'blue' }, { rank: 0 }] }, limit: 0 } })
        assert.equal(result.success, true, result.error?.join('; '))
        assert.equal(result.object.length, values.filter(value => value.team === 'blue').length + 1)
        assert.equal(new Set(ids(result.object)).size, result.object.length)
    } finally { await tree.close() }
})

test('covered settled predicates are not evaluated a second time on documents', async () => {
    const { tree, values } = await fixture(12)
    const leaf = values[0]
    const descriptor = Object.getOwnPropertyDescriptor(leaf, 'team')
    Object.defineProperty(leaf, 'team', { configurable: true, enumerable: true, get() { throw Error('document predicate was evaluated again') } })
    try {
        const response = await read(tree, { query: { team: 'blue' }, limit: 0 })
        assert.equal(response.success, true, response.error?.join('; '))
        assert.ok(ids(response.object).includes(leaf.uuid))
    } finally { Object.defineProperty(leaf, 'team', descriptor); await tree.close() }
})

test('a partially consumed query stream holds its primary until the iterator closes', async () => {
    const { tree, primary } = await fixture(24)
    try {
        const branch = await tree.getPrimaryBranch({ ...scope, method: 'object.read' })
        const stream = tree.getLeaves(tree.planner(branch, { team: 'blue' }))
        assert.equal((await stream.next()).done, false)
        assert.deepEqual(await tree.prune({ uuid: primary }), { count: 0 })
        await stream.return()
        assert.deepEqual(await tree.prune({ uuid: primary }), { count: 1 })
    } finally { await tree.close() }
})

test('root-only and equality scans stop at their page without restoring other columns', async () => {
    const { tree, disk, primary, values } = await fixture(160)
    try {
        for (const query of [{}, { team: 'blue' }]) {
            await tree.prune({ uuid: primary })
            const files = new Set(values.map(value => leafPath(value.uuid)))
            const accessed = [], execute = disk.execute.bind(disk)
            disk.execute = async request => { accessed.push(request); return execute(request) }
            const result = await read(tree, { query, index: 2, limit: 3 })
            assert.equal(result.success, true, result.error?.join('; '))
            assert.deepEqual(ids(result.object), ids(expected(values, { query, index: 2, limit: 3 })))
            assert.equal(accessed.filter(request => request.operation === 'read' && files.has(request.path)).length, 3)
            assert.equal(tree.pendingIndexCount, 0)
            disk.execute = execute
        }
    } finally { await tree.close() }
})

test('mixed types, missing values, container sorting and search follow the Filter/Utils contract', async () => {
    const { tree, primary, values } = await fixture(48)
    try {
        for (const filter of [
            { query: {}, sort: [{ key: 'mixed', direction: 'desc' }, { key: 'optional', direction: 'asc' }], limit: 12 },
            { query: { active: true }, sort: [{ key: 'tags', direction: 'desc' }, { key: 'rank', direction: 'asc' }], index: 2, limit: 7 },
            { query: { active: true }, search: { value: 'name-1', operator: 'or' }, sort: [{ key: 'rank', direction: 'desc' }], limit: 5 },
            { query: { team: 'red' }, sort: [{ key: 'profile.city', direction: 'asc' }, { key: 'rank', direction: 'desc' }], limit: 5 }
        ]) {
            await tree.prune({ uuid: primary })
            const result = await read(tree, filter)
            assert.equal(result.success, true, result.error?.join('; '))
            assert.deepEqual(ids(result.object), ids(expected(values, filter)))
            assert.equal(tree.pendingIndexCount, 0)
        }
    } finally { await tree.close() }
})

test('filtered update and delete use ordered pages and keep old indexed values out', async () => {
    const { tree, primary, values } = await fixture(32)
    try {
        await tree.prune({ uuid: primary })
        const filter = { query: { team: 'blue' }, sort: [{ key: 'rank', direction: 'desc' }], index: 1, limit: 2 }
        const targets = ids(expected(values, filter))
        const update = await tree.execute({ ...scope, method: 'object.update', filter, object: { $update: { $set: { team: 'changed' }, $inc: { score: 100 } } } })
        assert.equal(update.success, true, update.error?.join('; '))
        assert.deepEqual(ids(update.object), targets)
        assert.equal(update.filter.index, 3)
        await waitForIdle(tree)
        const blue = await read(tree, { query: { team: 'blue' }, limit: 0 })
        assert.ok(blue.object.every(value => !targets.includes(value.uuid)))
        const deletion = await tree.execute({ ...scope, method: 'object.delete', filter: { query: { team: 'changed' }, sort: [{ key: 'rank', direction: 'asc' }], limit: 1 } })
        assert.equal(deletion.success, true, deletion.error?.join('; '))
        assert.equal(deletion.object.length, 1)
        await waitForIdle(tree)
        assert.equal((await read(tree, { query: { team: 'changed' }, limit: 0 })).object.length, 1)
    } finally { await tree.close() }
})

test('empty containers remain distinct from missing fields for indexed predicates, sorting and cold mutations', async () => {
    const disk = new MemoryDisk(), tree = await createTestTree({ disk, size: 4, leafSize: 4 })
    const values = [[], {}, undefined, null, 0, '', false].map((cell, rank) => ({ uuid: `empty-${rank}`, rank, ...(cell === undefined ? {} : { cell }) }))
    const created = await tree.execute({ ...scope, method: 'object.create', object: values })
    assert.equal(created.success, true, created.error?.join('; '))
    await waitForIdle(tree)
    const primary = created.object[0].parent
    try {
        for (const query of [
            { cell: { $exists: true } }, { cell: { $exists: false } }, { cell: { $gte: 0 } },
            { cell: { $lt: 1 } }, { cell: [] }, { cell: {} }, { cell: { $eq: {} } }, { cell: { $ne: null } }
        ]) {
            await tree.prune({ uuid: primary })
            const filter = { query, sort: [{ key: 'cell', direction: 'asc' }], limit: 0 }
            const result = await read(tree, filter)
            assert.equal(result.success, true, result.error?.join('; '))
            assert.deepEqual(ids(result.object), ids(expected(values, filter)), JSON.stringify(query))
            assert.equal(tree.pendingIndexCount, 0)
        }
        await tree.prune({ uuid: primary })
        const changed = await tree.execute({ ...scope, method: 'object.update', object: { uuid: 'empty-0', $update: { $push: { cell: 3 } } } })
        assert.equal(changed.success, true, changed.error?.join('; '))
        await waitForIdle(tree)
        const empty = await read(tree, { query: { cell: [] }, limit: 0 })
        assert.ok(!ids(empty.object).includes('empty-0'))
        assert.deepEqual(ids((await read(tree, { query: { 'cell[0]': 3 }, limit: 0 })).object), ['empty-0'])
    } finally { await tree.close() }
})

test('filtered mutations retain their UUID selection while background indexing moves their driving values', async () => {
    const { tree, disk, primary, values } = await fixture(40)
    try {
        await tree.prune({ uuid: primary })
        const execute = disk.execute.bind(disk)
        const leaves = new Set(values.map(value => leafPath(value.uuid)))
        disk.execute = async request => {
            if (request.operation === 'read' && leaves.has(request.path)) await new Promise(resolve => setImmediate(resolve))
            return execute(request)
        }
        const response = await tree.execute({ ...scope, method: 'object.update', filter: { query: { rank: { $lt: 20 } }, limit: 0 }, object: { $update: { $inc: { rank: 1000 } } } })
        assert.equal(response.success, true, response.error?.join('; '))
        assert.equal(response.object.length, 20)
        assert.equal(new Set(ids(response.object)).size, 20)
        assert.ok(response.object.every(value => value.rank >= 1000 && value.rank < 1020))
        await waitForIdle(tree)
        assert.equal((await read(tree, { query: { rank: { $lt: 20 } }, limit: 0 })).object.length, 0)
        assert.equal((await read(tree, { query: { rank: { $gte: 1000 } }, limit: 0 })).object.length, 20)
    } finally { await tree.close() }
})
