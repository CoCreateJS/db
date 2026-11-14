import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDB } from '../src/index.js'
import { splitSerializedPartition } from '../src/partition.js'
import { fileId } from '../src/files.js'
import { readMemoryJSON, removeMemoryPath, memoryEntries } from '../src/memory.js'

const org = '000000000000000000000001'
const scope = { organization_id: org, storage: 'production', database: 'app', array: 'users' }
async function fixture(t, options = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'coc-uuid-layout-'))
    const db = createDB({ directory, memoryCache: true, ...options })
    const instances = [db]
    t.after(async () => {
        for (const instance of instances.toReversed()) await instance.close()
        removeMemoryPath(directory)
        await rm(directory, { recursive: true, force: true })
    })
    return { directory, db, instances, root: join(directory, org) }
}
const send = (db, method, extra = {}) => db.send({ ...scope, method, ...extra })
async function onlyFile(root, type) {
    const names = (await readdir(join(root, type))).filter(name => name.endsWith('.json'))
    assert.equal(names.length, 1)
    assert.match(names[0], /^[a-f0-9]{32}\.json$/)
    return { id: names[0].slice(0, -5), value: JSON.parse(await readFile(join(root, type, names[0]), 'utf8')) }
}

test('root and empty storage catalog survive deleting the last storage', async t => {
    const { db, root } = await fixture(t)
    const empty = await send(db, 'storage.read')
    assert.equal(empty.success, true, empty.error?.join('; '))
    const manifest = await readMemoryJSON(join(root, 'root.json'))
    const catalog = await readMemoryJSON(join(root, 'indexes', `${manifest.storages}.json`))
    assert.deepEqual(catalog.entries, [])
    await send(db, 'storage.create')
    await send(db, 'storage.delete')
    assert.strictEqual(await readMemoryJSON(join(root, 'root.json')), manifest)
    assert.strictEqual(await readMemoryJSON(join(root, 'indexes', `${manifest.storages}.json`)), catalog)
    assert.deepEqual(catalog.entries, [])
    const created = await send(db, 'storage.create')
    assert.equal(created.success, true, created.error?.join('; '))
    assert.equal((await readMemoryJSON(join(root, 'root.json'))).storages, manifest.storages)
})

test('all records use UUID filenames and metadata breadcrumbs reach every catalog', async t => {
    const { db, root } = await fixture(t)
    const body = { _id: '000000000000000000000009', name: 'Ada', tags: ['one', 'two'] }
    const result = await send(db, 'object.create', { object: body })
    assert.equal(result.success, true, result.error?.join('; '))
    assert.strictEqual(result.object[0], body)
    for (const type of ['storages', 'databases', 'arrays', 'objects']) {
        const record = await onlyFile(root, type)
        assert.notEqual(record.id, record.value._id)
        if (type !== 'objects') {
            const catalog = JSON.parse(await readFile(join(root, 'indexes', `${record.value.index}.json`), 'utf8'))
            assert.equal(catalog.id, record.value.index)
        }
    }
    const values = await readdir(join(root, 'values'))
    assert.ok(values.some(name => /^[a-f0-9]{32}\.json$/.test(name)))
    assert.equal((await readdir(root)).includes('catalogs'), false, 'logical catalog paths are not physical directories')
    assert.ok(result.distribution.includes(`${org}/objects/${fileId(body)}.json`))
})

test('updates mutate the stored references and retain the physical UUID', async t => {
    const { db, root } = await fixture(t, { disk: false, writeBehind: true, scheduleIndexing: () => {} })
    const nested = { city: 'before' }, values = [1, 2]
    const body = { score: 1, nested, values }
    await send(db, 'object.create', { object: body })
    const uuid = fileId(body)
    const patch = { $inc: { score: 2 }, $set: { 'nested.city': 'after', values: [3, 4] } }
    const result = await send(db, 'object.update', { object: { _id: body._id, $update: patch } })
    assert.equal(result.success, true, result.error?.join('; '))
    assert.strictEqual(result.object[0].$update, patch)
    assert.strictEqual(body.nested, nested)
    assert.strictEqual(body.values, values)
    assert.deepEqual(body.values, [3, 4])
    assert.equal(body.score, 3)
    assert.equal(fileId(body), uuid)
    assert.strictEqual(await readMemoryJSON(join(root, 'objects', `${uuid}.json`)), body)
    await db.flush()
})

test('reopening follows root.json and preserves duplicate public IDs in separate arrays', async t => {
    const { db, directory, instances, root } = await fixture(t)
    const id = '000000000000000000000009'
    const first = (await send(db, 'object.create', { object: { _id: id, value: 1 } })).object[0]
    const second = (await send(db, 'object.create', { array: 'other', object: { _id: id, value: 2 } })).object[0]
    assert.notEqual(fileId(first), fileId(second))
    await db.close()
    removeMemoryPath(directory)
    const reopened = createDB({ directory })
    instances.push(reopened)
    assert.equal((await send(reopened, 'object.read', { object: { _id: id } })).object[0].value, 1)
    assert.equal((await send(reopened, 'object.read', { array: 'other', object: { _id: id } })).object[0].value, 2)
    assert.ok(await readFile(join(root, 'root.json')))
})

test('an existing unversioned dataset is rejected without changing its files', async t => {
    const { db, root } = await fixture(t)
    const directory = join(root, 'storages', 'old-id')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'storage.json'), '{"preserve":true}')
    const response = await send(db, 'object.create', { object: { name: 'must not write' } })
    assert.equal(response.success, false)
    assert.match(response.error.join('; '), /separate path|migrate/)
    assert.equal(await readFile(join(directory, 'storage.json'), 'utf8'), '{"preserve":true}')
    assert.deepEqual(await readdir(root), ['storages'])
})

test('disk and persistence preparation retain the same values without structured cloning', async t => {
    const sent = []
    t.mock.method(globalThis, 'structuredClone', () => assert.fail('DB state must not be cloned'))
    const { db } = await fixture(t, { writeBehind: true, persistenceOptions: { storage: item => sent.push(item) } })
    const body = { name: 'shared', nested: { value: 1 } }
    const created = await send(db, 'object.create', { object: body })
    assert.equal(created.success, true, created.error?.join('; '))
    await db.flush()
    const record = sent.find(item => item.path === `${org}/objects/${fileId(body)}.json`)
    assert.ok(record)
    assert.strictEqual(record.value, body)
    assert.strictEqual(record.value.nested, body.nested)
})


test('storage name catalogs split through the same engine while root stays unchanged', async t => {
    const { db, root } = await fixture(t, { disk: false, nodeId: 'catalog-node', maxIndexBytes: 1024 })
    for (let i = 0; i < 40; i++) {
        const result = await send(db, 'storage.create', { storage: `storage-${String(i).padStart(3, '0')}-${'x'.repeat(40)}` })
        assert.equal(result.success, true, result.error?.join('; '))
    }
    const manifest = await readMemoryJSON(join(root, 'root.json'))
    const catalog = await db.readIndexPartition(`${org}/indexes/${manifest.storages}.json`)
    const nameId = catalog.entries.find(entry => entry[0] === 'name' && entry[1] === 'string')[2]
    const nameRoot = await db.readIndexPartition(`${org}/indexes/${nameId}.json`)
    assert.equal(nameRoot.entries.length, 40)
    let changed, passes = 0
    do {
        assert.ok(++passes < 30, 'catalog splitting must finish')
        changed = false
        for (const [, node] of memoryEntries(join(root, 'indexes'))) {
            if (node.catalog === manifest.storages && await splitSerializedPartition(node, Buffer.byteLength(JSON.stringify(node)))) changed = true
        }
    } while (changed)
    assert.ok(nameRoot.entries.length < 40, 'serialization splits the original live name node')
    assert.strictEqual(await readMemoryJSON(join(root, 'root.json')), manifest)
    assert.equal(catalog.id, manifest.storages)
    for (let i = 0; i < 40; i++) {
        const name = `storage-${String(i).padStart(3, '0')}-${'x'.repeat(40)}`
        const result = await send(db, 'storage.read', { storage: name })
        assert.equal(result.storage[0].name, name)
    }
})
