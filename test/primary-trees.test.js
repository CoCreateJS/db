import { testOrganization } from '../test-support/tree.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import DB from '../src/index.js'
import { databaseRuntimes } from '../src/runtime.js'
import { treeContexts } from '../src/tree/internal.js'
import { MemoryDisk } from '../test-support/memory-disk.mjs'
import { waitForIdle, waitForCondition } from './benchmarks/shared/wait-for-index.mjs'

const scope = { organization_id: 'primary-test', storage: 'main', database: 'app', array: 'first' }
const create = (db, array, object) => db.send({ ...scope, array, method: 'object.create', object })

test('organization routing creates independent primary Trees with no shared leaf map', async () => {
    const db = await DB.init({}, { prompt: false })
    try {
        const [a, b] = await Promise.all([create(db, 'first', { uuid: 'a', value: 1 }), create(db, 'second', { uuid: 'b', value: 2 })])
        assert.equal(a.success, true, a.error?.join('; '))
        assert.equal(b.success, true, b.error?.join('; '))
        const organization = await testOrganization(db, scope.organization_id)
        const first = await organization.getTree(a.object[0].parent)
        const second = await organization.getTree(b.object[0].parent)
        assert.notEqual(first.uuid, second.uuid)
        assert.equal(first.config.parent, first.uuid)
        assert.equal(second.config.parent, second.uuid)
        assert.deepEqual(first.config.roots, { object: {}, index: {} })
        assert.equal(await first.leaves.get('b'), undefined)
        assert.equal(await second.leaves.get('a'), undefined)
        assert.equal(treeContexts.get(first).leafCount, 1)
        assert.equal(treeContexts.get(second).leafCount, 1)
        assert.equal(Object.values(organization.config.leaves).filter(node => node.root === 'array').length, 2)
        const before = second.weight
        await first.leaves.get('a')
        assert.equal(second.weight, before)
        const duplicate = await create(db, 'second', { uuid: 'a', value: 3 })
        assert.equal(duplicate.success, false)
    } finally { await databaseRuntimes.get(db).close() }
})

test('harvesting drops one owner without storage work or touching a nested or neighboring Tree', async () => {
    const disk = new MemoryDisk()
    const db = await DB.init({}, { prompt: false, disk, roots: { storage: { database: { array: { object: {}, child: { entry: {} } } } } } })
    try {
        const a = await create(db, 'first', { value: 1 })
        const b = await create(db, 'second', { value: 2 })
        const nested = await db.send({ ...scope, child: 'nested', method: 'entry.create', entry: { value: 3 } })
        assert.equal(nested.success, true, nested.error?.join('; '))
        const org = await testOrganization(db, scope.organization_id)
        await waitForIdle(org)
        const primary = a.object[0].parent
        const first = org.trees.get(primary), second = org.trees.get(b.object[0].parent), child = org.trees.get(nested.entry[0].parent)
        const events = disk.events.length
        first.close = () => { throw Error('Harvesting must not walk or drain an already idle Tree') }
        assert.deepEqual(await org.harvest({ uuid: primary }), { count: 1 })
        assert.equal(org.trees.has(primary), false)
        assert.equal(org.trees.get(second.uuid), second)
        assert.equal(org.trees.get(child.uuid), child)
        assert.equal(disk.events.length, events)
        const result = await db.send({ ...scope, method: 'object.read', filter: { query: { value: 1 } } })
        assert.equal(result.success, true, result.error?.join('; '))
        assert.equal(result.object[0].uuid, a.object[0].uuid)
        assert.notEqual(org.trees.get(primary), first)
        assert.notEqual(result.object[0], a.object[0])
        assert.equal(org.trees.get(child.uuid), child)
    } finally { await databaseRuntimes.get(db).close() }
})

test('a blocked primary storage cycle does not block its neighbor indexing or harvesting', async () => {
    const disk = new MemoryDisk()
    let entered, release
    const started = new Promise(resolve => { entered = resolve })
    const blocked = new Promise(resolve => { release = resolve })
    const persistence = { queue: {}, async execute(request) {
        if (request.operation === 'read') return undefined
        if (request.kind === 'leaf' && request.uuid === 'blocked') { entered(); await blocked }
        return request
    } }
    const db = await DB.init({}, { prompt: false, disk, persistence })
    try {
        const a = await create(db, 'first', { uuid: 'blocked', value: 1 })
        await started
        const b = await create(db, 'second', { uuid: 'free', value: 2 })
        const org = await testOrganization(db, scope.organization_id)
        const first = await org.getTree(a.object[0].parent), second = await org.getTree(b.object[0].parent)
        await waitForIdle(treeContexts.get(second))
        await waitForCondition(() => org.harvestCandidates.includes(second))
        assert.equal(treeContexts.get(first).pendingIndexCount, 0)
        assert.ok(treeContexts.get(first).pendingDiskCount > 0)
        assert.deepEqual(await org.harvest({ uuid: first.uuid }), { count: 0 })
        assert.deepEqual(await org.harvest({ uuid: second.uuid }), { count: 1 })
        release()
        await waitForIdle(org)
        assert.deepEqual(await org.harvest({ uuid: first.uuid }), { count: 1 })
    } finally { release(); await databaseRuntimes.get(db).close() }
})

test('restart uses organization metadata to hydrate only the selected primary and preserves index UUIDs', async () => {
    const disk = new MemoryDisk()
    let db = await DB.init({}, { prompt: false, disk })
    let id, primary, indexes
    try {
        const a = await create(db, 'first', { value: 1 })
        await create(db, 'second', { value: 2 })
        id = a.object[0].uuid
        primary = a.object[0].parent
        const org = await testOrganization(db, scope.organization_id)
        await waitForIdle(org)
        indexes = org.trees.get(primary).config.indexes
    } finally { await databaseRuntimes.get(db).close() }
    db = await DB.init({}, { prompt: false, disk })
    try {
        const org = await testOrganization(db, scope.organization_id)
        assert.equal(org.trees.size, 0, 'root discovery does not initialize Trees')
        const read = await db.send({ organization_id: scope.organization_id, method: 'object.read', object: { uuid: id } })
        assert.equal(read.success, true, read.error?.join('; '))
        assert.equal(read.object[0].value, 1)
        assert.deepEqual([...org.trees.keys()], [primary])
        assert.deepEqual(org.trees.get(primary).config.indexes, indexes)
        assert.equal(org.pendingIndexCount, 0)
    } finally { await databaseRuntimes.get(db).close() }
})

test('root configuration edits apply to existing primary engines without introducing tree routing', async () => {
    const disk = new MemoryDisk()
    const db = await DB.init({}, { prompt: false, disk })
    try {
        const first = await create(db, 'first', { value: 1 })
        const org = await testOrganization(db, scope.organization_id)
        const tree = await org.getTree(first.object[0].parent)
        await org.roots.execute({ operation: 'set', path: 'storage.database.array.event', data: {} })
        assert.deepEqual(tree.config.roots.event, {})
        const result = await db.send({ ...scope, method: 'event.create', event: { value: 'configured' } })
        assert.equal(result.success, true, result.error?.join('; '))
        assert.equal(result.event[0].parent, tree.uuid)
        assert.equal(await tree.leaves.get(result.event[0].uuid), result.event[0])
    } finally { await databaseRuntimes.get(db).close() }
})

test('concurrent supplied UUID creates across primary Trees reserve one organization identity', async () => {
    const db = await DB.init({}, { prompt: false })
    try {
        const responses = await Promise.all([create(db, 'first', { uuid: 'shared' }), create(db, 'second', { uuid: 'shared' })])
        assert.equal(responses.filter(response => response.success).length, 1)
        assert.equal(responses.filter(response => !response.success).length, 1)
    } finally { await databaseRuntimes.get(db).close() }
})

test('cold primary creation retains stored UUID and object identity uniqueness', async () => {
    const disk = new MemoryDisk()
    const db = await DB.init({}, { prompt: false, disk })
    try {
        const created = await create(db, 'first', { uuid: 'original', _id: 'same-identity', value: 1 })
        const org = await testOrganization(db, scope.organization_id)
        await waitForIdle(org)
        assert.deepEqual(await org.harvest({ uuid: created.object[0].parent }), { count: 1 })
        const duplicate = await create(db, 'first', { uuid: 'different', _id: 'same-identity' })
        assert.equal(duplicate.success, false)
        assert.match(duplicate.error.join('; '), /duplicate identity/)
        assert.equal((await create(db, 'second', { uuid: 'original' })).success, false, 'UUIDs remain unique within an organization')
    } finally { await databaseRuntimes.get(db).close() }
})

test('structural deletion checks the child table for direct and filtered requests', async () => {
    const db = await DB.init({}, { prompt: false, disk: new MemoryDisk() })
    try {
        const record = await create(db, 'first', { value: 1 })
        await waitForIdle(databaseRuntimes.get(db))
        const org = await testOrganization(db, scope.organization_id)
        const primary = record.object[0].parent
        await org.harvest({ uuid: primary })
        for (const selector of [{ array: { uuid: primary } }, { filter: { query: { name: 'first' } } }]) {
            const result = await db.send({ organization_id: scope.organization_id, storage: scope.storage, database: scope.database, method: 'array.delete', ...selector })
            assert.equal(result.success, false)
            assert.match(result.error.join('; '), /child leaves/)
        }
        const deleted = await db.send({ ...scope, method: 'object.delete', object: { uuid: record.object[0].uuid } })
        assert.equal(deleted.success, true)
        await waitForIdle(databaseRuntimes.get(db))
        const empty = await db.send({ organization_id: scope.organization_id, storage: scope.storage, database: scope.database, method: 'array.delete', array: { uuid: primary } })
        assert.equal(empty.success, true, empty.error?.join('; '))
        assert.equal(org.config.leaves[primary], undefined)
    } finally { await databaseRuntimes.get(db).close() }
})

test('root edits protect ordinary rows even when their primary is cold', async () => {
    const db = await DB.init({}, { prompt: false, disk: new MemoryDisk(), roots: { object: {}, unused: {} } })
    try {
        const result = await db.send({ organization_id: scope.organization_id, method: 'object.create', object: { value: 1 } })
        assert.equal(result.success, true)
        const org = await testOrganization(db, scope.organization_id)
        await waitForIdle(org)
        await org.harvest()
        await assert.rejects(org.roots.execute({ operation: 'set', path: 'object', data: undefined }), /occupied root/)
        await assert.rejects(org.roots.execute({ operation: 'set', path: 'object', data: { child: {} } }), /occupied root/)
        await org.roots.execute({ operation: 'set', path: 'unused', data: undefined })
        assert.equal(org.roots.get('unused'), undefined)
    } finally { await databaseRuntimes.get(db).close() }
})

test('partially scoped queries order and paginate across independent primary Trees', async () => {
    const db = await DB.init({}, { prompt: false })
    try {
        await create(db, 'first', Array.from({ length: 40 }, (_, rank) => ({ rank: rank * 2, group: 'first' })))
        await create(db, 'second', Array.from({ length: 40 }, (_, rank) => ({ rank: rank * 2 + 1, group: 'second' })))
        const org = await testOrganization(db, scope.organization_id)
        await waitForIdle(org)
        const filter = { query: {}, sort: [{ key: 'rank', direction: 'desc' }], startingIndex: 3, limit: 4 }
        const result = await db.send({ organization_id: scope.organization_id, storage: 'main', method: 'object.read', filter })
        assert.equal(result.success, true, result.error?.join('; '))
        assert.deepEqual(result.object.map(row => row.rank), [76, 75, 74, 73])
        assert.equal(result.filter.index, 7)
        const defaultPage = await db.send({ organization_id: scope.organization_id, method: 'object.read', filter: { query: {} } })
        assert.equal(defaultPage.object.length, 50)
        const invalid = await db.send({ organization_id: scope.organization_id, method: 'object.read', filter: { index: -1 } })
        assert.equal(invalid.success, false)
    } finally { await databaseRuntimes.get(db).close() }
})
