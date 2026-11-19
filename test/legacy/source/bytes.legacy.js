import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPersistence } from '../src/persistence.js'
import { replaceJSON } from '../src/storage.js'
import { rm as remove } from '../src/io.js'
import { enableMemoryCache, removeMemoryPath } from '../src/memory.js'

test('sidecars reflect full persisted UTF-8 files, coalesce revisions, and remove deleted file sizes', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'coc-file-bytes-'))
    const store = createPersistence({ directory, debounceMs: 10000, maxWaitMs: 10000 })
    t.after(async () => { await store.close(); removeMemoryPath(directory); await rm(directory, { recursive: true, force: true }) })
    const path = join(directory, 'objects', 'one.json')
    const record = { _id: 'one', source: 'é'.repeat(10000), nested: { value: 1 } }
    store.stageJSON(path, record)
    record.nested.value = 22
    store.stageJSON(path, record)
    await assert.rejects(readFile(join(directory, 'objects', '.bytes')), { code: 'ENOENT' })
    const stringify = JSON.stringify
    let documentEncodings = 0
    const spy = t.mock.method(JSON, 'stringify', function (value, ...args) {
        if (value === record) documentEncodings++
        return stringify(value, ...args)
    })
    await store.flush()
    spy.mock.restore()
    assert.equal(documentEncodings, 1, 'accounting must reuse the complete disk-write encoding')
    const sizes = JSON.parse(await readFile(join(directory, 'objects', '.bytes'), 'utf8'))
    assert.equal(sizes['one.json'], (await stat(path)).size)
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), record)
    assert.equal('bytes' in record, false)
    store.remove(path)
    await store.flush()
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'objects', '.bytes'), 'utf8')), {})
})

test('write-through accounting stays local and memory-only writes create no sidecar', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'coc-file-bytes-'))
    t.after(async () => { removeMemoryPath(directory); await rm(directory, { recursive: true, force: true }) })
    const path = join(directory, 'object.json')
    await replaceJSON(path, { value: 'whole document' })
    assert.equal(JSON.parse(await readFile(join(directory, '.bytes'), 'utf8'))['object.json'], (await stat(path)).size)
    await remove(path)
    assert.deepEqual(JSON.parse(await readFile(join(directory, '.bytes'), 'utf8')), {})
    const volatile = join(directory, 'volatile')
    enableMemoryCache(volatile, { memoryOnly: true })
    await replaceJSON(join(volatile, 'object.json'), { value: 1 })
    await assert.rejects(stat(volatile), { code: 'ENOENT' })
})
