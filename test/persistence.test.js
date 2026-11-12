import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPersistence } from '../src/persistence.js'
import { readMemoryJSON, removeMemoryPath } from '../src/memory.js'

async function setup(t, options = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'coc-persist-timers-'))
    const writes = []
    const store = createPersistence({ directory, write: async item => writes.push(item.value), debounceMs: 25, maxWaitMs: 60, retryMs: 10, ...options })
    t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }) })
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
    return { directory, file: join(directory, 'item.json'), writes, store }
}

test('persistence cooldown resets per path and dirty values remain pinned until acknowledgment', async t => {
    const { directory, file, writes, store } = await setup(t)
    store.stageJSON(file, { value: 1 })
    t.mock.timers.tick(20)
    store.stageJSON(file, { value: 2 })
    t.mock.timers.tick(24)
    await setImmediate()
    assert.deepEqual(writes, [])
    removeMemoryPath(directory)
    assert.deepEqual(await readMemoryJSON(file), { value: 2 })
    t.mock.timers.tick(1)
    await setImmediate()
    assert.deepEqual(writes, [{ value: 2 }])
    assert.equal(store.stats().pending, 0)
})

test('maximum wait bounds a continuously reset persistence cooldown', async t => {
    const { file, writes, store } = await setup(t)
    store.stageJSON(file, { value: 0 })
    for (const value of [1, 2]) {
        t.mock.timers.tick(20)
        await setImmediate()
        store.stageJSON(file, { value })
    }
    t.mock.timers.tick(19)
    await setImmediate()
    assert.equal(writes.length, 0)
    store.stageJSON(file, { value: 3 })
    t.mock.timers.tick(1)
    await setImmediate()
    assert.deepEqual(writes, [{ value: 3 }])
})

test('disk failures retry automatically and explicit flush bypasses the cooldown', async t => {
    let attempts = 0
    t.mock.method(console, 'error', () => {})
    const { file, store } = await setup(t, { write: async () => {
        if (++attempts === 1) throw new Error('disk unavailable')
    } })
    store.stageJSON(file, { value: 1 })
    t.mock.timers.tick(25)
    await setImmediate()
    assert.equal(store.stats().pending, 1)
    assert.match(store.stats().error, /disk unavailable/)
    t.mock.timers.tick(10)
    await setImmediate()
    assert.equal(attempts, 2)
    assert.equal(store.stats().pending, 0)
    store.stageJSON(file, { value: 2 })
    await store.flush()
    assert.equal(attempts, 3)
    assert.equal(store.stats().pending, 0)
})

test('explicit drain joins an active write and bypasses the next item cooldown', async t => {
    let release, started
    const finished = new Promise(resolve => { release = resolve })
    const entered = new Promise(resolve => { started = resolve })
    const writes = []
    const { file, store } = await setup(t, { write: async item => {
        writes.push(item.value.value)
        if (item.value.value === 1) { started(); await finished }
    } })
    store.stageJSON(file, { value: 1 })
    t.mock.timers.tick(25)
    await entered
    store.stageJSON(join(file, '..', 'second.json'), { value: 2 })
    const draining = store.flush()
    release()
    await draining
    assert.deepEqual(writes, [1, 2])
    assert.equal(store.stats().pending, 0)
})

test('a timer overlapping a memory transaction waits without reporting a persistence failure', async t => {
    const { file, writes, store } = await setup(t)
    store.stageJSON(file, { value: 1 })
    const release = store.hold()
    t.mock.timers.tick(25)
    await setImmediate()
    assert.deepEqual(writes, [])
    assert.equal(store.stats().error, undefined)
    release()
    t.mock.timers.tick(0)
    await setImmediate()
    assert.deepEqual(writes, [{ value: 1 }])
})
