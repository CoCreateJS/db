import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import cluster from 'node:cluster'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Disk from '@cocreate/disk'
import IPC from '@cocreate/cluster/src/send/ipc.js'
import DB from '../src/index.js'
import { databaseRuntimes } from '../src/runtime.js'
import { createBenchmarkRecord } from '../test/fixtures/lifecycle.mjs'

function server() {
    const server = new EventEmitter()
    server.id = 'db-orchestrator-test'
    server.isPrimary = cluster.isPrimary
    server.isWorker = cluster.isWorker
    server.workerId = cluster.isWorker ? Number(process.env.WORKER_ID) : null
    server.workers = new Map()
    server.workers.awareness = new Map()
    server.emitAsync = async (event, payload) => {
        let response = payload
        for (const handler of server.listeners(event)) response = await handler(payload)
        return response
    }
    server.send = IPC.init(server, new Map())
    return server
}

if (cluster.isWorker) {
    const host = server()
    let leafReads = 0, held, release
    const disk = await Disk.init({ directory: process.env.DB_DIRECTORY })
    const execute = disk.execute.bind(disk)
    disk.execute = async request => {
        const value = await execute(request)
        if (request.operation === 'read' && request.path?.includes('/leaves/') && value !== undefined) leafReads++
        return value
    }
    const persistence = { async execute(request) {
        if (request.operation === 'read') return undefined
        if (request.kind === 'leaf' && request.uuid === held) await new Promise(resolve => { release = resolve })
        return request
    } }
    const db = await DB.init(host, { prompt: false, disk, persistence, size: 64 })
    const runtime = databaseRuntimes.get(db)
    host.on('test.inspect', message => ({ uuid: message.uuid, result: {
        ...runtime.trees.status(), leafReads, pid: process.pid, memory: process.memoryUsage(),
        organizations: [...runtime.trees.organizations.keys()]
    } }))
    host.on('test.rank', message => {
        for (const tables of runtime.trees.organizations.values()) for (const tree of tables.values())
            tree.weight = message.weights[tree.uuid] ?? 1000
        return { uuid: message.uuid, result: true }
    })
    host.on('test.hold', message => { held = message.leaf; return { uuid: message.uuid, result: true } })
    host.on('test.release', message => { held = undefined; release?.(); return { uuid: message.uuid, result: true } })
    host.on('test.client', async message => ({ uuid: message.uuid, result: await db.send(message.request) }))
    host.on('test.stop', async message => { await runtime.close(); return { uuid: message.uuid, result: true } })
    await host.send({ method: 'test.ready', primary: true, server: host.id, broadcast: false })
} else {
    const count = Number(process.env.DB_RECORDS ?? 80)
    const workers = Number(process.env.DB_WORKERS ?? 2)
    const groupCount = Number(process.env.DB_GROUPS ?? 4)
    assert.ok(Number.isSafeInteger(groupCount) && groupCount >= 4, 'DB_GROUPS must be at least four')
    assert.ok(Number.isSafeInteger(count) && count >= groupCount && count % groupCount === 0, 'DB_RECORDS must be divisible by DB_GROUPS')
    assert.ok(Number.isSafeInteger(workers) && workers >= 1 && workers <= 4, 'Fixture supports one to four workers')
    const directory = await mkdtemp(join(tmpdir(), 'cocreate-worker-db-'))
    const host = server()
    let readyCount = 0, resolveReady
    const ready = new Promise(resolve => { resolveReady = resolve })
    host.on('test.ready', message => {
        if (++readyCount === workers) resolveReady()
        return { uuid: message.uuid, result: true }
    })
    cluster.setupPrimary({ exec: fileURLToPath(import.meta.url), args: [], serialization: 'advanced' })
    const children = []
    const initStart = performance.now()
    for (let id = 1; id <= workers; id++) {
        const worker = cluster.fork({ WORKER_ID: String(id), DB_DIRECTORY: directory })
        children.push(worker)
        host.workers.set(id, { id, process: worker })
    }
    const scope = { organization_id: 'worker-org', storage: 'test', database: 'app' }
    const request = async (worker, method, extra = {}) => {
        const response = await host.send({ method, worker, server: host.id, primary: false, broadcast: false, ...extra })
        if (response.success === false || response.error) throw new Error(response.error)
        return response.result
    }
    let db, runtime
    const diagnostics = []
    try {
        await ready
        const disk = await Disk.init({ directory })
        db = await DB.init(host, { prompt: false, disk, size: 64 })
        runtime = databaseRuntimes.get(db)
        const initializationMs = performance.now() - initStart
        const groups = Array.from({ length: groupCount }, (_, group) => ({ ...scope, array: `table-${group}` }))
        const values = groups.map((_, group) => Array.from({ length: count / groupCount }, (_, rank) => ({
            ...createBenchmarkRecord(group * count / groupCount + rank, count, scope.organization_id), table: group
        })))
        const fixtureHash = createHash('sha256').update(JSON.stringify(values)).digest('hex')
        const ownership = await db.organizations.get(scope.organization_id)
        const start = performance.now()
        const parents = []
        for (let group = 0; group < groups.length; group++) {
            const created = await db.send({ ...groups[group], method: 'object.create', object: values[group].slice(0, 1) })
            assert.equal(created.success, true, created.error?.join('; '))
            parents.push(created.object[0].parent)
        }
        const fixtureReady = performance.now()
        const acknowledgementStart = performance.now()
        await Promise.all(groups.map(async (group, number) => {
            for (let offset = 1; offset < values[number].length; offset += 1000) {
                const response = await db.send({ ...group, method: 'object.create', object: values[number].slice(offset, offset + 1000) })
                assert.equal(response.success, true, response.error?.join('; '))
            }
        }))
        const acknowledgementMs = fixtureReady - start + performance.now() - acknowledgementStart
        async function idle() {
            const timeout = Number(process.env.DB_INDEX_TIMEOUT_MS ?? 1800000)
            const deadline = Date.now() + timeout
            let nextReport = Date.now() + 15000
            while ((await runtime.status()).pendingIndexCount) {
                if (Date.now() > deadline) throw new Error(`Worker index queues did not finish within ${timeout}ms`)
                if (Date.now() >= nextReport) {
                    console.log(JSON.stringify({ phase: 'index-drain', pendingIndexCount: (await runtime.status()).pendingIndexCount,
                        elapsedMs: timeout - (deadline - Date.now()) }))
                    nextReport = Date.now() + 15000
                }
                await new Promise(resolve => setTimeout(resolve, 20))
            }
        }
        await idle()
        const createAndIndexMs = performance.now() - start
        assert.equal(runtime.trees.organizations.size, 0, 'orchestrator must never create a local Tree')
        assert.deepEqual([...ownership.owners.values()], Array.from({ length: ownership.owners.size }, (_, i) => i % workers + 1))
        const status = await runtime.status()
        assert.equal(status.pendingIndexCount, 0)
        for (const tree of status.trees) assert.equal(tree.workerId, ownership.owners.get(tree.uuid))
        const inspections = await Promise.all([...host.workers.keys()].map(worker => request(worker, 'test.inspect')))
        assert.equal(new Set(inspections.map(worker => worker.pid)).size, workers)
        const primaryMemory = process.memoryUsage()

        for (let group = 0; group < groups.length; group++) {
            const result = await db.send({ ...groups[group], method: 'object.read', filter: {
                query: { table: group }, sort: [{ key: 'rank', direction: 'desc' }], startingIndex: 2, limit: 3
            } })
            assert.equal(result.success, true, result.error?.join('; '))
            assert.deepEqual(result.object.map(row => row.rank), values[group].slice(-5, -2).map(row => row.rank).reverse())
        }
        const combined = await db.send({ ...scope, method: 'object.read', filter: {
            query: { $or: [{ table: 0 }, { table: 3 }] }, sort: [{ key: 'rank', direction: 'desc' }], startingIndex: 2, limit: 5
        } })
        assert.equal(combined.success, true, combined.error?.join('; '))
        assert.deepEqual(combined.object.map(row => row.uuid), values.flat().filter(row => row.table === 0 || row.table === 3)
            .sort((a, b) => b.rank - a.rank).slice(2, 7).map(row => row.uuid))
        const owner = ownership.owners.get(parents[0])
        const fromWorker = await request(owner, 'test.client', { request: { ...groups[0], method: 'object.read', object: { uuid: values[0][0].uuid } } })
        assert.equal(fromWorker.object[0].uuid, values[0][0].uuid, 'worker ingress routes through coordinator back to owner')
        const bare = await db.send({ organization_id: scope.organization_id, method: 'object.read', object: { uuid: values[1][0].uuid } })
        assert.equal(bare.object[0].uuid, values[1][0].uuid)
        const wrong = await db.send({ ...groups[1], method: 'object.read', object: { uuid: values[0][0].uuid } })
        assert.equal(wrong.object.length, 0)
        const otherOrg = await db.send({ ...groups[0], organization_id: 'other-org', method: 'object.create', object: { uuid: values[0][0].uuid, value: 'isolated' } })
        assert.equal(otherOrg.success, true, otherOrg.error?.join('; '))
        await idle()
        const changed = await db.send({ ...groups[0], method: 'object.update', object: { uuid: values[0][0].uuid, table: 99 } })
        assert.equal(changed.success, true, changed.error?.join('; '))
        await idle()
        assert.equal((await db.send({ ...groups[0], method: 'object.read', filter: { query: { table: 99 } } })).object.length, 1)
        const deleted = await db.send({ ...groups[0], method: 'object.delete', object: { uuid: values[0][0].uuid } })
        assert.equal(deleted.success, true)
        await idle()
        assert.equal((await db.send({ ...groups[0], method: 'object.read', object: { uuid: values[0][0].uuid } })).object.length, 0)

        assert.deepEqual(await ownership.prune({ uuid: parents[1] }), { count: 1 })
        assert.equal((await db.send({ ...groups[1], method: 'object.read', filter: { query: { table: 1 }, limit: 3 } })).object.length, 3)

        // Each worker ranks its own engines. The coordinator retains placement.
        for (const worker of host.workers.keys()) {
            const own = parents.filter(uuid => ownership.owners.get(uuid) === worker)
            const weights = Object.fromEntries(own.map((uuid, i) => [uuid, i + 10]))
            await request(worker, 'test.rank', { weights })
            const result = await request(worker, 'db.tree', { tree: { operation: 'prune', limit: 1 } })
            assert.equal(result.count, 1)
            const after = await request(worker, 'test.inspect')
            assert.equal(after.trees.some(tree => tree.uuid === own[0]), false)
            assert.equal(ownership.owners.get(own[0]), worker)
            const group = parents.indexOf(own[0])
            const beforeReads = after.leafReads
            const restored = await db.send({ ...groups[group], method: 'object.read', filter: {
                query: { table: group }, sort: [{ key: 'rank', direction: 'desc' }], limit: 3
            } })
            assert.equal(restored.object.length, 3)
            assert.equal((await request(worker, 'test.inspect')).leafReads - beforeReads, 3, 'cold read restores only its page')
        }
        await request(owner, 'test.hold', { leaf: values[0][1].uuid })
        const update = await db.send({ ...groups[0], method: 'object.update', object: { uuid: values[0][1].uuid, table: 98 } })
        assert.equal(update.success, true, update.error?.join('; '))
        // Wait until that worker has started the queued cycle, then ask it to prune.
        await new Promise(resolve => setTimeout(resolve, 30))
        const blocked = await request(owner, 'test.inspect')
        assert.ok(blocked.trees.find(tree => tree.uuid === parents[0]).pendingIndexCount > 0)
        const protectedResult = await request(owner, 'db.tree', { tree: { operation: 'prune', organization_id: scope.organization_id, uuid: parents[0] } })
        assert.equal(protectedResult.count, 0)
        host.emit('telemetry', { data: { serverId: host.id, workerId: 0, timestamp: 1, memory: { max: 75 } } })
        await new Promise(resolve => setTimeout(resolve, 30))
        assert.ok((await runtime.status()).trees.some(tree => tree.uuid === parents[0]), 'node pressure cannot remove pending Tree')
        host.emit('telemetry', { data: { serverId: host.id, workerId: 0, timestamp: 2, memory: { max: 50 } } })
        await request(owner, 'test.release')
        await idle()
        assert.ok((await runtime.status()).trees.some(tree => tree.uuid === parents[0]), '50% signal stops removal after pending work completes')
        assert.equal((await db.send({ ...groups[0], method: 'object.read', object: { uuid: values[0][1].uuid } })).object[0].table, 98)
        diagnostics.push('round robin and stable ownership', 'worker ingress and UUID routing', 'query sort and pagination',
            'CRUD and organization isolation', 'worker-local weights', 'pending storage protected', 'cold page hydration', '75/50 pressure signals')
        const result = { status: 'passed', fixture: `lifecycle v3 plus table field, ${groupCount} tables`, fixtureHash, records: count, workers, groups: groupCount, recordsPerGroup: count / groupCount, organization: scope.organization_id,
            node: process.version, initializationMs, routingSeedMs: fixtureReady - start, acknowledgementMs, createAndIndexMs,
            primaryTreeCount: runtime.trees.organizations.size, ownerAssignments: [...ownership.owners],
            dataOwners: parents.map(uuid => ({ uuid, workerId: ownership.owners.get(uuid) })), pendingIndexCount: (await runtime.status()).pendingIndexCount,
            primaryMemory, workerMemory: inspections.map(worker => ({ pid: worker.pid, ...worker.memory })), diagnostics }
        if (process.env.DB_RESULT) await writeFile(process.env.DB_RESULT, JSON.stringify(result, null, 2) + '\n')
        console.log(JSON.stringify(result))
    } finally {
        for (const id of host.workers.keys()) await request(id, 'test.release')
        if (runtime) await runtime.close()
        for (const id of host.workers.keys()) await request(id, 'test.stop')
        await Promise.all(children.map(worker => new Promise(resolve => { worker.once('exit', resolve); worker.disconnect() })))
        await rm(directory, { recursive: true, force: true })
    }
}
