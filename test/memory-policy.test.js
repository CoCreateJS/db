import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Tree } from '../src/tree/index.js'
import { LocalTier } from '../src/tree/local.js'
import { MemoryPolicy } from '../src/tree/memory.js'
import createDB from '../src/index.js'
import { updateLeaf } from '../src/leaf.js'

test('memory policy follows the pressure ladder and evicts one lowest weight group per tier', async () => {
    const calls = []
    const local = { async evictLowestWeight() { calls.push(['index']); return { count: 0 } } }
    const leaves = { async evictLowestWeight() { calls.push(['leaf']); return { count: 0 } } }
    const policy = new MemoryPolicy(local, {memory: 25, systemMemory: 4000}, leaves)
    for (const [i, pressure] of [.09, .10, .20, .30, .40, .50, .60, .80, .90].entries()) {
        policy.check(i * 100, pressure * 1000)
        await policy.flush()
        assert.equal(policy.stage, i)
    }
    assert.deepEqual(policy.samples.map(sample => sample.threshold), [.10, .20, .30, .40, .50, .60, .80, .90])
    assert.equal(calls.filter(([kind]) => kind === 'leaf').length, 8)
    assert.equal(calls.filter(([kind]) => kind === 'index').length, 8)
})

test('requests at the budget bypass the interval and coalesce during an active batch', async () => {
    let release
    let calls = 0
    const local = {
        evictLowestWeight() {
            calls++
            return new Promise(resolve => { release = resolve })
        }
    }
    let leafPasses = 0
    const leaves = { async evictLowestWeight() { leafPasses++ } }
    const policy = new MemoryPolicy(local, {memory: 25, systemMemory: 4000}, leaves)
    const releaseBatch = async () => {
        release({ count: 0 })
        await new Promise(setImmediate)
    }

    policy.check(0, 900)
    const running = policy.index.job
    await new Promise(setImmediate)
    policy.check(1, 1000)
    policy.check(2, 1400)
    await new Promise(setImmediate)
    assert.equal(policy.index.job, running)
    assert.equal(policy.stage, 8)
    assert.equal(calls, 1)
    assert.equal(leafPasses, 3)

    await releaseBatch()
    assert.equal(calls, 2)
    assert.equal(leafPasses, 3)
    await releaseBatch()
    await policy.flush()
    assert.deepEqual(policy.samples.map(({ rss }) => rss), [900, 1400])

    policy.check(3, 1000)
    await new Promise(setImmediate)
    assert.equal(calls, 3)
    await releaseBatch()
    await policy.flush()

    policy.check(103, 980)
    await new Promise(setImmediate)
    assert.equal(policy.stage, 8)
    await releaseBatch()
    await policy.flush()
    policy.check(203, 874)
    await new Promise(setImmediate)
    assert.equal(policy.stage, 7)
    await releaseBatch()
    await policy.flush()
})

test('adaptive enters disk-first at 90 percent pressure and releases below hysteresis', () => {
    const policy = new MemoryPolicy({ async evictLowestWeight() {} }, { memory: 25, systemMemory: 4000 })
    policy.check(0, 899)
    assert.equal(policy.diskFirst, false)
    policy.check(1, 900)
    assert.equal(policy.diskFirst, true)
    policy.check(2, 875)
    assert.equal(policy.diskFirst, true)
    policy.check(3, 874)
    assert.equal(policy.diskFirst, false)
})

test('pressure below disk-first clears pending urgent eviction work', async () => {
    let release
    let calls = 0
    const local = {
        evictLowestWeight() {
            calls++
            return new Promise(resolve => { release = resolve })
        }
    }
    const policy = new MemoryPolicy(local, {memory: 25, systemMemory: 4000})
    policy.check(0, 1000)
    await new Promise(setImmediate)
    policy.check(1, 1000)
    policy.check(2, 874)
    release({ count: 0 })
    await policy.flush()
    assert.equal(calls, 1)
})

test('the default database memory budget is 25 percent of system memory, capped by available memory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cocreatedb-memory-budget-'))
    try {
        const db = createDB({}, { directory, memoryPolicy: { systemMemory: 8192, availableMemory: 4096 } })
        assert.equal(db.memoryPolicy.requestedBudget, 2048)
        assert.equal(db.memoryPolicy.availableMemory, 4096)
        assert.equal(db.memoryPolicy.budget, 2048)

        const limited = createDB({}, { directory: directory + '-limited', memoryPolicy: { systemMemory: 8192, availableMemory: 512 } })
        assert.equal(limited.memoryPolicy.requestedBudget, 2048)
        assert.equal(limited.memoryPolicy.budget, 512)
    } finally {
        await rm(directory, { recursive: true, force: true })
        await rm(directory + '-limited', { recursive: true, force: true })
    }
})

test('memory acknowledgement returns the hot mutation without forcing a warm write', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cocreatedb-ack-memory-'))
    try {
        const db = createDB({}, { directory, memoryPolicy: false, acknowledgement: 'memory' })
        const root = { organization_id: 'org', storage: 'store', database: 'db', array: 'items' }
        const send = (method, extra) => db.send({ ...root, method: `object.${method}`, ...extra })
        const created = await send('create', { object: { uuid: 'memory-record', rank: 1, status: 'new' } })

        assert.equal(created.success, true)
        assert.equal(db.mode, 'adaptive')
        assert.equal(db.acknowledgement, 'memory')
        assert.equal(created.object[0].uuid, 'memory-record')
        assert.ok(db.leafTier.reference('memory-record'))
        assert.equal(db.leafTier.warm.has('memory-record'), false)
        assert.equal(db.leafTier.writes, 0)
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test('disk acknowledgement writes local state while adaptive mode retains it hot', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cocreatedb-ack-disk-'))
    try {
        const db = createDB({}, { directory, acknowledgement: 'disk' })
        const root = { organization_id: 'org', storage: 'store', database: 'db', array: 'items' }
        const send = (method, extra) => db.send({ ...root, method: `object.${method}`, ...extra })
        const created = await send('create', { object: { uuid: 'disk-record', rank: 7 } })
        assert.equal(created.success, true)
        assert.equal(created.object[0].uuid, 'disk-record')
        assert.equal(db.mode, 'adaptive')
        assert.equal(db.acknowledgement, 'disk')
        assert.ok(db.leafTier.reference('disk-record'))
        assert.ok(db.leafTier.warm.has('disk-record'))
        assert.ok(db.leafTier.writes > 0)
        assert.ok(db.local.writes > 0)
        assert.deepEqual(JSON.parse(await readFile(db.local.leafPath('disk-record'), 'utf8')).object.rank, 7)
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test('disk-first uses warm files per request without coupling the acknowledgement', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cocreatedb-disk-first-'))
    try {
        const db = createDB({}, { directory, config: { mode: 'disk-first' }, acknowledgement: 'memory' })
        const root = { organization_id: 'org', storage: 'store', database: 'db', array: 'items' }
        const send = (method, extra) => db.send({ ...root, method: `object.${method}`, ...extra })
        const created = await send('create', { object: { uuid: 'disk-first-record', rank: 3 } })
        assert.equal(created.success, true)
        assert.equal(db.mode, 'disk-first')
        assert.equal(db.acknowledgement, 'memory')
        await db.flushDisk()
        assert.equal(db.leafTier.reference('disk-first-record'), undefined)
        assert.ok(db.leafTier.warm.has('disk-first-record'))

        const reads = db.leafTier.reads
        const read = await send('read', { object: { uuid: 'disk-first-record' } })
        assert.equal(read.object[0].rank, 3)
        assert.ok(db.leafTier.reads > reads)
        await db.flushDisk()
        assert.equal(db.leafTier.reference('disk-first-record'), undefined)
        assert.ok(db.leafTier.warm.has('disk-first-record'))
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test('disk-cache mode clears the base and seeds config from startup options', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cocreatedb-disk-cache-'))
    try {
        await mkdir(join(directory, 'branches'), { recursive: true })
        await mkdir(join(directory, 'leaves'), { recursive: true })
        await writeFile(join(directory, 'branches', 'stale-branch.json'), '{}')
        await writeFile(join(directory, 'leaves', 'stale-leaf.json'), '{}')
        await writeFile(join(directory, 'config.json'), '{"stale":true}')

        const db = createDB({}, { directory, mode: 'disk-cache', config: { roots: { $organization_id: { storage: {} } } } })
        assert.equal(db.mode, 'disk-cache')
        assert.equal(db.local.directory, directory)
        assert.equal(db.local.branchDirectory, join(directory, 'branches'))
        assert.equal(db.local.leafDirectory, join(directory, 'leaves'))
        assert.equal(db.local.warmBranches.size, 0)
        assert.equal(db.leafTier.warm.size, 0)
        assert.equal(await readFile(join(directory, 'config.json'), 'utf8'), JSON.stringify(db.config))
        assert.equal(await readFile(join(directory, 'branches', 'stale-branch.json')).then(() => 'exists', () => 'missing'), 'missing')
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test('config lives at the base and restores dynamic roots on restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cocreatedb-config-restart-'))
    const root = { organization_id: 'org', storage: 'store', database: 'db', array: 'items' }
    try {
        const first = createDB({}, { directory, acknowledgement: 'disk', memoryPolicy: false })
        const created = await first.send({ ...root, method: 'object.create', object: { uuid: 'restart-record', rank: 8 } })
        assert.equal(created.success, true)
        assert.equal(first.baseDirectory, directory)
        assert.equal(first.local.branchDirectory, join(directory, 'branches'))
        assert.equal(first.local.leafDirectory, join(directory, 'leaves'))

        const persisted = JSON.parse(await readFile(join(directory, 'config.json'), 'utf8'))
        assert.ok(Object.values(persisted.leaves).some(item => item.root === '$organization_id' && item.name === 'org'))

        const restarted = createDB({}, { directory, memoryPolicy: false })
        assert.deepEqual(restarted.config.leaves, persisted.leaves)
        const read = await restarted.send({ ...root, method: 'object.read', object: { uuid: 'restart-record' } })
        assert.equal(read.success, true)
        assert.equal(read.object[0].rank, 8)
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test('adaptive restart reuses persisted index route UUIDs and serves indexed reads', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cocreatedb-index-restart-'))
    const root = { organization_id: 'org', storage: 'store', database: 'db', array: 'items' }
    try {
        const first = createDB({}, { directory, memoryPolicy: false })
        for (let offset = 0; offset < 120; offset += 20) {
            const object = Array.from({ length: 20 }, (_, index) => ({
                uuid: `route-restart-${offset + index}`,
                group: `group-${(offset + index) % 4}`,
                rank: offset + index
            }))
            const response = await first.send({ ...root, method: 'object.create', object })
            assert.equal(response.success, true)
        }
        const scopeUuids = Object.keys(first.config.leaves).sort()
        await new Promise(setImmediate)
        const afterAcknowledgement = JSON.parse(await readFile(join(directory, 'config.json'), 'utf8'))
        assert.ok(afterAcknowledgement.indexes.some(route => route.key === 'group' && route.type === 'string'))
        assert.ok(first.leafTier.warm.has('route-restart-0'))
        await first.flushDisk()
        const persisted = JSON.parse(await readFile(join(directory, 'config.json'), 'utf8'))
        const routeUuids = new Map(persisted.indexes.map(({ key, type, uuid }) => [`${key}\0${type}`, uuid]))
        assert.ok(routeUuids.has('group\0string'))
        assert.ok(routeUuids.has('rank\0number'))

        const restarted = createDB({}, { directory, memoryPolicy: false })
        assert.deepEqual(Object.keys(restarted.config.leaves).sort(), scopeUuids)
        assert.equal(restarted.config.indexes.find(route => route.key === 'group' && route.type === 'string').uuid, routeUuids.get('group\0string'))
        assert.equal(restarted.config.indexes.find(route => route.key === 'rank' && route.type === 'number').uuid, routeUuids.get('rank\0number'))

        const result = await restarted.send({ ...root, method: 'object.read', filter: { query: { group: 'group-2' }, limit: 50 } })
        assert.equal(result.success, true)
        assert.deepEqual(result.object.map(item => item.uuid).sort(), Array.from({ length: 30 }, (_, index) => `route-restart-${index * 4 + 2}`).sort())
        assert.ok(restarted.local.reads > 0)
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test('a missing base path uses a temporary directory and creates the standard layout', async () => {
    const db = createDB({}, { memoryPolicy: false })
    try {
        assert.ok(db.baseDirectory.startsWith(tmpdir()))
        assert.ok(await readFile(join(db.baseDirectory, 'config.json'), 'utf8'))
        assert.equal(db.local.branchDirectory, join(db.baseDirectory, 'branches'))
        assert.equal(db.local.leafDirectory, join(db.baseDirectory, 'leaves'))
    } finally {
        await rm(db.baseDirectory, { recursive: true, force: true })
    }
})

test('root config updates are written to the base in every local mode', async () => {
    for (const mode of ['adaptive', 'disk-first', 'disk-cache']) {
        const directory = await mkdtemp(join(tmpdir(), `cocreatedb-config-${mode}-`))
        try {
            const db = createDB({}, { directory, mode, memoryPolicy: false })
            const config = db.config
            config.setValue('roots.$organization_id.storage.database.array.extra', {})
            const persisted = JSON.parse(await readFile(join(directory, 'config.json'), 'utf8'))
            assert.deepEqual(persisted.roots.$organization_id.storage.database.array.extra, {})
        } finally {
            await rm(directory, { recursive: true, force: true })
        }
    }
})

test('memory pressure evicts adaptively without changing the selected mode', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cocreatedb-adaptive-pressure-'))
    try {
        const db = createDB({}, {
            directory,
            deferIndex: false,
            memoryPolicy: { memory: .01, systemMemory: 8192 }
        })
        const root = { organization_id: 'org', storage: 'store', database: 'db', array: 'items' }
        const response = await db.send({ ...root, method: 'object.create', object: { uuid: 'pressure-record', rank: 3 } })
        assert.equal(response.success, true)
        await db.memoryPolicy.flush()
        await db.flushDisk()
        assert.equal(db.mode, 'adaptive')
        assert.equal(db.effectiveMode, 'disk-first')
        assert.ok(db.leafTier.warm.has('pressure-record'))
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test('persistence acknowledgement is rejected until an external provider is connected', () => {
    assert.throws(() => createDB({}, { acknowledgement: 'persistence' }), /external persistence integration/)
})

test('index writes leave view weight alone and invalidate an in-flight offload', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cocreatedb-index-eviction-'))
    try {
        const entries = new Map()
        const local = new LocalTier(directory, id => entries.get(id))
        const tree = new Tree(8, local, 'status')
        function insert(value) {
            const entry = { uuid: String(value), value }
            entries.set(entry.uuid, entry)
            tree.insert(entry)
            return entry
        }

        const first = insert(1)
        assert.equal(tree.root.viewed, 0)
        const stale = local.evictLowestWeight()
        const second = insert(2)
        assert.equal(tree.root.viewed, 0)
        assert.equal((await stale).count, 0)
        assert.equal(tree.root.onDisk, false)
        assert.equal(local.writes, 0)

        assert.equal((await local.evictLowestWeight()).count, 1)
        assert.equal(tree.root.onDisk, true)
        assert.deepEqual([...tree.scan(1, 2)], [first, second])
        assert.equal(local.reads, 1)
        assert.equal(tree.root.viewed, 1)
        tree.remove(first)
        assert.equal(tree.root.viewed, 1)
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test('offload releases live entries and restores only the affected field index', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cocreatedb-detached-entries-'))
    try {
        const db = createDB({}, { directory, memoryPolicy: false, size: 4 })
        const root = { organization_id: 'org', storage: 'local', database: 'db', array: 'contacts' }
        const send = (action, input) => db.send({ ...root, method: 'object.' + action, ...input })
        const created = await send('create', {
            object: Array.from({ length: 8 }, (_, value) => ({ uuid: 'contact-' + value, status: value, notes: value }))
        })
        assert.equal(created.success, true)
        db.flushIndex()

        const contact = created.object[0]
        const oldStatus = contact.getIndex('status')
        const oldNotes = contact.getIndex('notes')
        const statusLeaf = oldStatus.index
        const notesLeaf = oldNotes.index
        const statusParent = statusLeaf.parent

        // Changes waiting for deferred reconciliation still need the old entry value.
        const pendingOffload = db.local.evictOne(statusLeaf)
        updateLeaf(created.object[1], { status: 101 })
        assert.equal(await pendingOffload, false)
        db.flushIndex()

        assert.equal(statusLeaf.toDisk(), true)
        assert.equal(statusLeaf.parent, null)
        assert.equal(statusLeaf.parentUuid, statusParent.uuid)
        assert.equal(statusParent.branches.some(ref => ref === statusLeaf), false)
        assert.equal(statusParent.branches.some(ref => ref.uuid === statusLeaf.uuid), true)
        assert.equal(db.local.weights.has(statusLeaf), false)
        assert.equal(await db.local.evictOne(notesLeaf), true)
        assert.equal(oldStatus.index, null)
        assert.equal(oldNotes.index, null)
        assert.equal(Object.hasOwn(statusLeaf, 'entries'), false)
        assert.equal(contact.notes, 0)
        assert.equal(db.local.reads, 0)

        const read = await send('read', { filter: { query: { status: 0 }, limit: 1 } })
        assert.equal(read.object[0], contact)
        assert.equal(db.local.reads, 1)
        assert.equal(notesLeaf.onDisk, true)

        assert.equal(await contact.toDisk(), true)
        assert.equal(statusLeaf.onDisk, true)
        const restored = contact.getIndex('status')
        assert.equal(restored, oldStatus)
        assert.notEqual(restored.index, statusLeaf)
        assert.equal(restored.index.uuid, statusLeaf.uuid)
        assert.equal(restored.value, 0)
        assert.equal(db.leafTier.reads, 1)
        assert.equal(notesLeaf.onDisk, true)

        const updated = await send('update', { object: { uuid: contact.uuid, status: 99 } })
        assert.equal(updated.success, true)
        db.flushIndex()
        assert.equal(notesLeaf.onDisk, true)
        assert.deepEqual((await send('read', { filter: { query: { status: 0 } } })).object, [])
        assert.equal((await send('read', { filter: { query: { status: 99 } } })).object[0], contact)

        const deleted = await send('delete', { object: { uuid: contact.uuid } })
        assert.equal(deleted.success, true)
        db.flushIndex()
        assert.deepEqual((await send('read', { filter: { query: { notes: 0 } } })).object, [])
        assert.equal(statusLeaf.getParent().uuid, statusParent.uuid)
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})
