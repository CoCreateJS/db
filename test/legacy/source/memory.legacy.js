import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createDB } from '../src/object/index.js'
import { memoryStats, readMemoryJSON, removeMemoryPath, writeMemoryJSON } from '../src/memory.js'
import { replaceJSON } from '../src/storage.js'

const fixture = async run => {
    const directory = await mkdtemp(join(tmpdir(), 'cocreate-demand-memory-'))
    try { await run(directory) }
    finally {
        removeMemoryPath(directory)
        await rm(directory, { recursive: true, force: true })
    }
}

test('memory cache startup loads only root breadcrumbs and requested JSON', async () => {
    await fixture(async directory => {
        const requested = join(directory, 'requested.json')
        await writeFile(requested, JSON.stringify({ value: 'requested' }))
        // An unrelated invalid file must not affect opening the database.
        await writeFile(join(directory, 'unused.json'), '{invalid JSON')
        const db = createDB({ directory, memoryCache: true })
        assert.equal((await db.ready).format, 'cocreate-uuid-v1')
        const baseline = db.memoryStats()
        assert.equal(baseline.files, 2)
        assert.deepEqual(await readMemoryJSON(requested), { value: 'requested' })
        assert.equal(db.memoryStats().files, baseline.files + 1)
        assert.equal(db.memoryStats().serializedBytes, baseline.serializedBytes + Buffer.byteLength(JSON.stringify({ value: 'requested' })))
        await assert.rejects(readMemoryJSON(join(directory, 'unused.json')), SyntaxError)
        assert.equal(db.memoryStats().files, baseline.files + 1, 'failed reads must not populate the cache')
    })
})

test('cold and warm cache reads reuse the same live object', async () => {
    await fixture(async directory => {
        const file = join(directory, 'item.json')
        await writeFile(file, JSON.stringify({ nested: { value: 1 } }))
        await createDB({ directory, memoryCache: true }).ready
        const first = await readMemoryJSON(file)
        first.nested.value = 2
        assert.strictEqual(await readMemoryJSON(file), first)
        assert.deepEqual(await readMemoryJSON(file), { nested: { value: 2 } })
        await rm(file)
        assert.strictEqual(await readMemoryJSON(file), first, 'a warm read uses memory')
        removeMemoryPath(file)
        assert.equal(await readMemoryJSON(file), undefined)
        assert.equal(memoryStats(directory).files, 2)
    })
})

test('persisted updates refresh demand-cached values and clearing memory preserves disk data', async () => {
    await fixture(async directory => {
        const file = join(directory, 'item.json')
        await writeFile(file, JSON.stringify({ value: 1 }))
        await createDB({ directory, memoryCache: true }).ready
        await readMemoryJSON(file)
        const updated = { value: 2 }
        await replaceJSON(file, updated)
        updated.value = 3
        assert.deepEqual(await readMemoryJSON(file), { value: 2 })
        removeMemoryPath(directory)
        assert.equal(memoryStats(directory).files, 0)
        assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { value: 2 })
        assert.deepEqual(await readMemoryJSON(file), { value: 2 })
        assert.equal(memoryStats(directory).files, 1)
    })
})

test('disabled cache does not retain reads, writes, or missing-file results', async () => {
    await fixture(async directory => {
        const file = join(directory, 'item.json')
        await createDB({ directory, memoryCache: false }).ready
        assert.equal(await readMemoryJSON(file), undefined)
        await writeFile(file, JSON.stringify({ value: 1 }))
        assert.deepEqual(await readMemoryJSON(file), { value: 1 })
        writeMemoryJSON(file, { value: 2 })
        assert.equal(memoryStats(directory).files, 0)
        assert.deepEqual(await readMemoryJSON(file), { value: 1 })
        await writeFile(file, JSON.stringify({ value: 3 }))
        assert.deepEqual(await readMemoryJSON(file), { value: 3 })
    })
})

test('enabling memory cache on an existing database starts cold and warms through CRUD', async () => {
    await fixture(async directory => {
        const disk = createDB({ directory })
        const created = await disk.send({ method: 'object.create', database: 'test', array: 'items', object: { name: 'stored' } })
        assert.equal(created.success, true, created.error)
        const cached = createDB({ directory, memoryCache: true })
        await cached.ready
        assert.equal(cached.memoryStats().files, 1)
        const read = await cached.send({ method: 'object.read', database: 'test', array: 'items', object: { _id: created.object[0]._id } })
        assert.equal(read.success, true, read.error)
        assert.equal(read.object[0].name, 'stored')
        assert.ok(cached.memoryStats().files > 0)
        const missing = join(directory, 'missing.json')
        const before = cached.memoryStats().files
        assert.equal(await readMemoryJSON(missing), undefined)
        assert.equal(cached.memoryStats().files, before)
    })
})
