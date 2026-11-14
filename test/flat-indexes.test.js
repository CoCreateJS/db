import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readdir, readFile, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDB, createIndex } from '../src/index.js'
import { removeMemoryPath } from '../src/memory.js'

const organization_id = '000000000000000000000001'
const scope = { organization_id, storage: 'production', database: 'app', array: 'items' }
async function fixture(t) {
    const directory = await mkdtemp(join(tmpdir(), 'coc-flat-indexes-'))
    const db = createDB({ directory, nodeId: 'self', memoryCache: true })
    const instances = [db]
    t.after(async () => {
        for (const instance of instances.toReversed()) await instance.close()
        removeMemoryPath(directory)
        await rm(directory, { recursive: true, force: true })
    })
    return { directory, db, instances }
}
async function files(directory, org = organization_id) {
    const path = join(directory, org, 'indexes')
    const names = (await readdir(path)).filter(name => name.endsWith('.json'))
    return Promise.all(names.map(async name => ({ name, ...JSON.parse(await readFile(join(path, name), 'utf8')) })))
}

test('organization indexes are sibling ID files, isolated across scopes and usable after restart', async t => {
    const { directory, db, instances } = await fixture(t)
    const objectId = '000000000000000000000009'
    const scopes = [scope, { ...scope, storage: 'other' }, { ...scope, database: 'other' }, { ...scope, array: 'other' },
        { ...scope, organization_id: '000000000000000000000002' }]
    for (let i = 0; i < scopes.length; i++)
        assert.equal((await db.send({ ...scopes[i], method: 'object.create', object: { _id: objectId, value: i } })).success, true)
    const nodes = await files(directory)
    const ids = new Set(nodes.map(node => node.id))
    assert.equal(ids.size, nodes.length)
    for (const node of nodes) {
        assert.match(node.name, /^[a-f0-9]{32}\.json$/)
        assert.equal(node.name, `${node.id}.json`)
        assert.ok(ids.has(node.catalog), 'each node references an existing catalog root')
        if (node.id === node.catalog) assert.equal(typeof node.path, 'string')
    }
    await db.close()
    removeMemoryPath(directory)
    const reopened = createDB({ directory })
    instances.push(reopened)
    for (let i = 0; i < scopes.length; i++) {
        const result = await reopened.send({ ...scopes[i], method: 'object.read', object: { _id: objectId } })
        assert.equal(result.success, true, result.error?.join('; '))
        assert.equal(result.object[0].value, i)
    }
    assert.deepEqual(new Set((await files(directory)).map(node => node.id)), ids)
})

for (const type of ['array', 'database', 'storage']) test(`${type}.delete removes its flat index trees and preserves sibling data`, async t => {
    const { directory, db } = await fixture(t)
    const created = await db.send({ ...scope, method: 'object.create', object: { value: 1 } })
    const sibling = { ...scope, storage: 'sibling' }
    const held = await db.send({ ...sibling, method: 'object.create', object: { value: 2 } })
    const storage = (await db.send({ ...scope, method: 'storage.read' })).storage[0]
    const database = (await db.send({ ...scope, method: 'database.read' })).database[0]
    const array = (await db.send({ ...scope, method: 'array.read' })).array[0]
    let prefix = `catalogs/${storage._id}`
    if (type !== 'storage') prefix += `/databases/${database._id}`
    if (type === 'array') prefix += `/arrays/${array._id}`
    const before = await files(directory)
    const roots = new Set(before.filter(node => node.path === prefix || node.path?.startsWith(prefix + '/')).map(node => node.id))
    assert.ok(roots.size)
    const result = await db.send({ ...scope, method: `${type}.delete` })
    assert.equal(result.success, true, result.error?.join('; '))
    const after = await files(directory)
    assert.equal(after.some(node => roots.has(node.catalog)), false)
    const read = await db.send({ ...sibling, method: 'object.read', object: { _id: held.object[0]._id } })
    assert.equal(read.object[0].value, 2)
    assert.notEqual(created.object[0]._id, held.object[0]._id)
})

test('legacy nested index files require migration instead of appearing empty', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'coc-nested-indexes-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const folder = join(directory, 'db', 'items', 'index')
    await mkdir(folder, { recursive: true })
    const original = JSON.stringify({ id: 'root', kind: 'catalog', length: 0, entries: [] })
    await writeFile(join(folder, 'index.json'), original)
    const index = createIndex({ directory })
    await assert.rejects(index.read('db', 'items'), /require migration/)
    assert.equal(await readFile(join(folder, 'index.json'), 'utf8'), original)
    assert.equal((await readdir(directory)).includes('indexes'), false)
})

test('dropping a partial local index does not acquire missing partitions from peers', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'coc-drop-partial-index-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    let dropping = false
    const index = createIndex({ directory, readPartition: () => {
        assert.equal(dropping, false, 'deletion must not fetch a missing partition')
    } })
    await index.create('db', 'items', 'score', 1, 'one')
    const node = (await index.read('db', 'items', 'score')).indexes.number
    await rm(join(directory, 'indexes', `${node.id}.json`))
    dropping = true
    await index.drop('db', 'items')
    assert.deepEqual((await readdir(join(directory, 'indexes'))).filter(name => name.endsWith('.json')), [])
})
