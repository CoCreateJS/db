import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Disk from '@cocreate/disk'
import DB from '../src/index.js'
import { databaseRuntimes } from '../src/runtime.js'
import { nodeMemory } from '../test/benchmarks/shared/node-memory.mjs'
import { waitForIndex } from '../test/benchmarks/shared/wait-for-index.mjs'

const workerId = Number(process.env.BENCH_WORKER_ID)
const organizationId = process.env.BENCH_ORGANIZATION_ID
const recordCount = Number(process.env.BENCH_RECORDS_PER_WORKER)
const diskMode = process.env.BENCH_DISK ?? 'local'
const diskDirectory = await mkdtemp(join(tmpdir(), `cocreate-db-worker-affinity-${workerId}-`))
const filesystemStats = {}
const fileKind = path => path.includes('/leaves/') ? 'leaf' : path.includes('/branches/') ? 'branch' : 'config'
const fileMethods = ['writeFile', 'rename', 'access', 'readFile', 'unlink', 'mkdir']
const nativeFileMethods = Object.fromEntries(fileMethods.map(method => [method, fs[method]]))
for (const method of fileMethods) {
    fs[method] = async (...args) => {
        const path = String(args[0])
        const tracked = path.startsWith(`${diskDirectory}/`)
        const stats = tracked ? filesystemStats[`${fileKind(path)}.${method}`] ??=
            { startedCalls: 0, payloadBytesStarted: 0, payloadBytesCompleted: 0, completedCalls: 0, failedCalls: 0 } : undefined
        const data = args[1]
        const bytes = method === 'writeFile' && tracked
            ? typeof data === 'string' ? Buffer.byteLength(data, args[2]?.encoding ?? args[2] ?? 'utf8') : data?.byteLength ?? 0
            : 0
        if (stats) { stats.startedCalls++; stats.payloadBytesStarted += bytes }
        try {
            const result = await nativeFileMethods[method](...args)
            if (stats) { stats.completedCalls++; stats.payloadBytesCompleted += bytes }
            return result
        } catch (error) {
            if (stats) stats.failedCalls++
            throw error
        }
    }
}
syncBuiltinESMExports()
const adapter = diskMode === 'disabled' ? undefined : diskMode === 'noop' ? { queue: Object.create(null), async execute({ operation }) {
    if (operation === 'read') return undefined
    if (operation === 'has') return false
    if (operation === 'list') return []
    return true
} } : await Disk.init({ directory: diskDirectory })
const diskStats = { submittedRequests: 0, fulfilledRequests: 0, failedRequests: 0, outstandingRequests: 0, submittedWriteBytes: 0,
    submittedRequestsByKind: {}, submittedWriteBytesByKind: {}, outstandingRequestsByKind: {},
    supersededRequestsByKind: {}, cancelledRequestsByKind: {}, failures: {} }
const disk = adapter ? { queue: adapter.queue ?? Object.create(null), async execute(request) {
    const tracked = typeof request.operation === 'string'
    const key = `${request.kind ?? 'unknown'}.${request.operation ?? 'unknown'}`
    if (tracked) {
        diskStats.submittedRequests++
        diskStats.outstandingRequests++
        diskStats.outstandingRequestsByKind[key] = (diskStats.outstandingRequestsByKind[key] ?? 0) + 1
        diskStats.submittedRequestsByKind[key] = (diskStats.submittedRequestsByKind[key] ?? 0) + 1
        if (request.operation === 'write') {
            const bytes = Buffer.byteLength(typeof request.data === 'string' ? request.data : JSON.stringify(request.data ?? null))
            diskStats.submittedWriteBytes += bytes
            diskStats.submittedWriteBytesByKind[key] = (diskStats.submittedWriteBytesByKind[key] ?? 0) + bytes
        }
    }
    try {
        const value = await adapter.execute(request)
        if (tracked) {
            diskStats.fulfilledRequests++
            if (value?.superseded) diskStats.supersededRequestsByKind[key] = (diskStats.supersededRequestsByKind[key] ?? 0) + 1
            if (value?.cancelled) diskStats.cancelledRequestsByKind[key] = (diskStats.cancelledRequestsByKind[key] ?? 0) + 1
        }
        return value
    } catch (error) {
        if (tracked) {
            diskStats.failedRequests++
            const failure = `${key}:${error.code ?? error.name ?? 'Error'}`
            diskStats.failures[failure] = (diskStats.failures[failure] ?? 0) + 1
        }
        throw error
    } finally { if (tracked) { diskStats.outstandingRequests--; diskStats.outstandingRequestsByKind[key]-- } }
} } : undefined
const diskSnapshot = () => structuredClone(diskStats)
const host = new EventEmitter()
host.id = `worker-affinity-${workerId}`
host.workerId = workerId
host.isPrimary = false
host.isWorker = true
const db = await DB.init(host, { prompt: false, ...(disk ? { disk } : {}), size: 64 })
const runtime = databaseRuntimes.get(db)
const cpuStart = process.cpuUsage()
let closed = false

const send = (message, value) => process.send?.({ requestId: message.requestId, ok: true, value })
const fail = (message, error) => process.send?.({ requestId: message.requestId, ok: false,
    error: { message: error.message || String(error), stack: error.stack } })
const snapshot = () => ({ workerId, organizationId, pid: process.pid,
    pendingIndexCount: runtime.pendingIndexCount, pendingDiskCount: runtime.pendingDiskCount,
    memory: process.memoryUsage(), peakRssBytes: process.resourceUsage().maxRSS * (process.platform === 'darwin' ? 1 : 1024),
    cpuUsage: process.cpuUsage(cpuStart), dbMemory: { ...runtime.memory }, diskRequests: diskSnapshot(),
    filesystem: structuredClone(filesystemStats) })

const telemetry = setInterval(() => host.emit('telemetry', {
    data: { serverId: host.id, workerId, timestamp: Date.now(), memory: nodeMemory() }
}), 1000)
const resources = setInterval(() => process.send?.({ event: 'resource', ...snapshot() }), 1000)
await db.organizations.get(organizationId)
for (const key of Object.keys(filesystemStats)) delete filesystemStats[key]
process.send({ event: 'ready', workerId, organizationId, pid: process.pid, memory: process.memoryUsage(), diskDirectory })

process.on('message', async message => {
    try {
        if (message.type === 'createBatch') {
            const response = await db.send({ ...message.root, method: 'object.create', object: message.records })
            if (!response.success) throw new Error(response.error?.join('; ') || 'Batch create failed')
            return send(message, { count: response.object.length,
                pendingIndexCount: runtime.pendingIndexCount, pendingDiskCount: runtime.pendingDiskCount })
        }
        if (message.type === 'crud') {
            if (message.request.organization_id !== organizationId)
                throw new Error(`Worker ${workerId} does not own organization ${message.request.organization_id}`)
            const response = await db.send(message.request)
            if (!response.success) throw new Error(response.error?.join('; ') || `${message.request.method} failed`)
            return send(message, { count: response.object?.length ?? 0,
                pendingIndexCount: runtime.pendingIndexCount, pendingDiskCount: runtime.pendingDiskCount })
        }
        if (message.type === 'drainIndex') {
            const pendingBefore = runtime.pendingIndexCount
            const started = performance.now()
            await waitForIndex(runtime, { timeoutMs: Number(process.env.BENCH_INDEX_TIMEOUT_MS ?? 1200000), progressMs: 0 })
            return send(message, { ...snapshot(), pendingBefore, drainMs: performance.now() - started })
        }
        if (message.type === 'snapshot') return send(message, snapshot())
        if (message.type === 'finishWithoutDiskDrain') {
            clearInterval(telemetry)
            clearInterval(resources)
            send(message, snapshot())
            setImmediate(() => process.exit(0))
            return
        }
        if (message.type === 'validate') {
            const { benchmarkUuid } = await import('../test/fixtures/lifecycle.mjs')
            const original = await db.send({ ...message.root, method: 'object.read', object: { uuid: benchmarkUuid(0) } })
            if (!original.success || original.object.length !== 1 || original.object[0].organization_id !== organizationId)
                throw new Error('Worker-local UUID read failed')
            const indexed = await db.send({ ...message.root, method: 'object.read', filter: { query: { group: 'group-3' }, limit: 100 } })
            const expected = Math.min(100, Math.floor((recordCount + 6) / 10))
            if (!indexed.success || indexed.object.length !== expected ||
                indexed.object.some(record => record.organization_id !== organizationId || record.group !== 'group-3'))
                throw new Error('Worker-local indexed read failed')
            const sampleUuid = benchmarkUuid(recordCount)
            const sample = await db.send({ ...message.root, method: 'object.read', object: { uuid: sampleUuid } })
            const shouldExist = message.deleted !== true
            if (!sample.success || sample.object.length !== (shouldExist ? 1 : 0) ||
                shouldExist && sample.object[0].revision !== 1)
                throw new Error('CRUD sample lifecycle validation failed')
            return send(message, { ...snapshot(), uuidRead: true, indexedRead: true, crudSample: true })
        }
        if (message.type === 'close') {
            clearInterval(telemetry)
            clearInterval(resources)
            await runtime.close()
            await rm(diskDirectory, { recursive: true, force: true })
            closed = true
            send(message, { closed: true })
            process.disconnect()
            return
        }
        throw new Error(`Unknown affinity benchmark command: ${message.type}`)
    } catch (error) { fail(message, error) }
})

process.on('disconnect', async () => {
    clearInterval(telemetry)
    clearInterval(resources)
    if (!closed) await runtime.close().catch(() => {})
    process.exit(0)
})
