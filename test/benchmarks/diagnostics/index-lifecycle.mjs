import assert from 'node:assert/strict'
import { fork, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { cpus, totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Disk from '@cocreate/disk'
import { createBenchmarkRecord } from '../../fixtures/lifecycle.mjs'
import { waitForIndex } from '../shared/wait-for-index.mjs'

const script = fileURLToPath(import.meta.url)
const organizationId = process.env.BENCH_ORGANIZATION_ID ?? '000000000000000000000001'
const primaryTreeCount = Number(process.env.BENCH_PRIMARY_TREES ?? 80)
const recordsPerTree = Number(process.env.BENCH_RECORDS_PER_TREE ?? 5000)
const totalRecords = primaryTreeCount * recordsPerTree
const batchSize = Number(process.env.BENCH_BATCH_SIZE ?? 500)
const lscpu = Object.fromEntries(JSON.parse(execFileSync('lscpu', ['-J'], { encoding: 'utf8' })).lscpu.map(row => [row.field.replace(/:$/, ''), row.data]))
const runId = new Date().toISOString()
const output = resolve(process.env.BENCH_OUTPUT_DIR ?? `test/benchmarks/providers/cocreatedb/results/index-lifecycle-${totalRecords}-${primaryTreeCount}x${recordsPerTree}-${runId.replaceAll(':', '-')}`)

function readCpuStat() {
    const lines = execFileSync('cat', ['/proc/stat'], { encoding: 'utf8' }).split('\n')
    const row = lines[0].trim().split(/\s+/).slice(1).map(Number)
    const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = row
    return { total: user + nice + system + idle + iowait + irq + softirq + steal, idle, iowait, busy: user + nice + system + irq + softirq + steal }
}

const treeNames = Array.from({ length: primaryTreeCount }, (_, i) => `primary_${String(i + 1).padStart(2, '0')}`)
const roots = Object.fromEntries(treeNames.map(name => [name, {}]))
const fixtureHash = createHash('sha256')
let fixtureHashStarted = false
function hashRecord(record) {
    if (fixtureHashStarted) fixtureHash.update(',')
    fixtureHash.update(JSON.stringify(record))
    fixtureHashStarted = true
}

async function childRun() {
    const directory = await mkdtemp('/tmp/cocreatedb-index-lifecycle-')
    const adapter = await Disk.init({ directory })
    const io = { started: 0, completed: 0, failed: 0, inFlight: 0, bytesWritten: 0, operationCounts: {} }
    const disk = { async execute(request) {
        const measured = typeof request.operation === 'string'
        if (measured) {
            io.started++
            io.inFlight++
            const kind = request.kind ?? 'unknown'
            const key = `${kind}.${request.operation}`
            io.operationCounts[key] = (io.operationCounts[key] ?? 0) + 1
            if (request.operation === 'write') io.bytesWritten += Buffer.byteLength(typeof request.data === 'string' ? request.data : JSON.stringify(request.data ?? null))
        }
        try {
            const result = await adapter.execute(request)
            if (measured) io.completed++
            return result
        } catch (error) {
            if (measured) io.failed++
            throw error
        } finally { if (measured) io.inFlight-- }
    } }

    const { createRuntime } = await import('../../../src/runtime.js')
    const { EventEmitter } = await import('node:events')
    const db = await createRuntime(Object.assign(new EventEmitter(), { id: 'index-lifecycle-benchmark', isPrimary: true }), { disk, size: 64, roots })
    const records = treeNames.map((_, treeIndex) => Array.from({ length: recordsPerTree }, (_, offset) => {
        const record = createBenchmarkRecord(treeIndex * recordsPerTree + offset, totalRecords, organizationId)
        hashRecord(record)
        return record
    }))
    const cpuStart = readCpuStat()
    const startedAt = new Date().toISOString()
    const lifecycleStart = performance.now()
    let acknowledgedRecords = 0
    let acknowledgementCallMs = 0
    let acknowledgementCalls = 0
    const crud = { create: { requestsStarted: 0, requestsAcknowledged: 0, recordsSubmitted: 0, recordsAcknowledged: 0, acknowledgementMs: [] },
        update: { requestsStarted: 0, requestsAcknowledged: 0, recordsSubmitted: 0, recordsAcknowledged: 0, acknowledgementMs: [] },
        delete: { requestsStarted: 0, requestsAcknowledged: 0, recordsSubmitted: 0, recordsAcknowledged: 0, acknowledgementMs: [] },
        read: { requestsStarted: 0, requestsAcknowledged: 0, recordsSubmitted: 0, recordsAcknowledged: 0, acknowledgementMs: [] } }
    const diskSamples = []
    let previousSample = { at: performance.now(), completed: io.completed, started: io.started }
    let previousOperationCounts = {}
    let previousBytesWritten = 0
    let previousCrud = Object.fromEntries(Object.entries(crud).map(([name, row]) => [name, { requests: row.requestsAcknowledged, records: row.recordsAcknowledged }]))
    let phase = 'create-acknowledgement'
    let stopRequested = false
    process.on('message', message => { if (message === 'stop') stopRequested = true })
    const sampleDisk = () => {
        const now = performance.now()
        const elapsedMs = now - previousSample.at
        const operationsByKindActionPerSecond = {}
        for (const key of new Set([...Object.keys(previousOperationCounts), ...Object.keys(io.operationCounts)]))
            operationsByKindActionPerSecond[key] = elapsedMs > 0 ? ((io.operationCounts[key] ?? 0) - (previousOperationCounts[key] ?? 0)) * 1000 / elapsedMs : 0
        const sample = { elapsedMs: Math.round(now - lifecycleStart), phase,
            crud: Object.fromEntries(Object.entries(crud).map(([name, row]) => {
                const prior = previousCrud[name]
                const result = { requestsStarted: row.requestsStarted, requestsAcknowledged: row.requestsAcknowledged,
                    recordsSubmitted: row.recordsSubmitted, recordsAcknowledged: row.recordsAcknowledged,
                    requestsPerSecond: elapsedMs > 0 ? (row.requestsAcknowledged - prior.requests) * 1000 / elapsedMs : 0,
                    recordsPerSecond: elapsedMs > 0 ? (row.recordsAcknowledged - prior.records) * 1000 / elapsedMs : 0 }
                previousCrud[name] = { requests: row.requestsAcknowledged, records: row.recordsAcknowledged }
                return [name, result]
            })),
            completed: io.completed, started: io.started, failed: io.failed,
            inFlight: io.inFlight, completedOpsPerSecond: elapsedMs > 0 ? (io.completed - previousSample.completed) * 1000 / elapsedMs : 0,
            startedOpsPerSecond: elapsedMs > 0 ? (io.started - previousSample.started) * 1000 / elapsedMs : 0,
            operationCounts: { ...io.operationCounts }, operationsByKindActionPerSecond,
            bytesWritten: io.bytesWritten, bytesWrittenPerSecond: elapsedMs > 0 ? (io.bytesWritten - previousBytesWritten) * 1000 / elapsedMs : 0,
            pendingIndexItems: db.pendingIndexCount, pendingDiskItems: db.pendingDiskCount }
        diskSamples.push(sample)
        process.send({ type: 'progress', sample })
        previousSample = { at: now, completed: io.completed, started: io.started }
        previousOperationCounts = { ...io.operationCounts }
        previousBytesWritten = io.bytesWritten
    }
    const sampler = setInterval(sampleDisk, 1000)
    let error
    try {
        let allAcknowledgedMs = null
        for (let offset = 0; offset < recordsPerTree; offset += batchSize) {
            const count = Math.min(batchSize, recordsPerTree - offset)
            await Promise.all(treeNames.map(async (name, i) => {
                const before = performance.now()
                const op = crud.create
                op.requestsStarted++
                op.recordsSubmitted += count
                acknowledgementCalls++
                const response = await db.send({ organization_id: organizationId, method: `${name}.create`, [name]: records[i].slice(offset, offset + count) })
                const ackMs = performance.now() - before
                acknowledgementCallMs += ackMs
                op.acknowledgementMs.push(ackMs)
                op.requestsAcknowledged++
                assert.equal(response.success, true, response.error?.join('; '))
                assert.equal(response[name].length, count)
                op.recordsAcknowledged += response[name].length
                acknowledgedRecords += count
            }))
            if (stopRequested) break
        }
        if (acknowledgedRecords === totalRecords) allAcknowledgedMs = performance.now() - lifecycleStart
        if (!stopRequested) {
            phase = 'index-drain'
            await waitForIndex(db, { timeoutMs: 1200000, progressMs: 10000 })
        }
        const indexReadyAt = stopRequested ? null : performance.now()
        phase = stopRequested ? 'paused' : 'index-ready'
        sampleDisk()
        const cpuEnd = readCpuStat()
        const elapsedMs = (indexReadyAt ?? performance.now()) - lifecycleStart
        const cpuTotal = cpuEnd.total - cpuStart.total
        const cpuBusy = cpuEnd.busy - cpuStart.busy
        const cpuIoWait = cpuEnd.iowait - cpuStart.iowait
        const queue = { pendingIndexItems: db.pendingIndexCount, pendingDiskItems: db.pendingDiskCount }
        const result = {
            status: stopRequested ? 'paused' : 'index-ready', startedAt, capturedAt: new Date().toISOString(),
            ...(indexReadyAt === null ? {} : { indexReadyAt: new Date().toISOString() }), organizationCount: 1,
            organizationId, primaryTreeCount, recordsPerPrimaryTree: recordsPerTree, totalRecords,
            batchSize, fixtureHash: fixtureHash.digest('hex'), node: process.version,
            host: { architecture: process.arch, cpuModel: cpus()[0]?.model ?? 'unknown', logicalCpus: cpus().length,
                physicalCores: Number(lscpu['Core(s) per socket']) * Number(lscpu['Socket(s)']), threadsPerCore: Number(lscpu['Thread(s) per core']),
                sockets: Number(lscpu['Socket(s)']), virtualization: lscpu['Hypervisor vendor'] ?? null,
                totalMemoryBytes: totalmem(), cpuAccounting: '/proc/stat; host-wide aggregate across all logical CPUs' },
            lifecycle: { wallMs: elapsedMs, acknowledgedRecords, acknowledgementCalls,
                acknowledgementWallMs: allAcknowledgedMs, acknowledgementCallTimeSumMs: acknowledgementCallMs,
                indexTailMs: indexReadyAt !== null && allAcknowledgedMs !== null ? Math.max(0, elapsedMs - allAcknowledgedMs) : null,
                acknowledgementRequestsPerSecond: allAcknowledgedMs > 0 ? acknowledgementCalls * 1000 / allAcknowledgedMs : null,
                acknowledgedRecordsPerSecond: allAcknowledgedMs > 0 ? acknowledgedRecords * 1000 / allAcknowledgedMs : null,
                indexedRecordsPerSecond: indexReadyAt !== null && elapsedMs > 0 ? acknowledgedRecords * 1000 / elapsedMs : null,
                indexQueueItemsAtEnd: queue.pendingIndexItems },
            crud: Object.fromEntries(Object.entries(crud).map(([name, row]) => {
                const sorted = [...row.acknowledgementMs].sort((a, b) => a - b)
                const percentile = p => sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null
                return [name, { requestsStarted: row.requestsStarted, requestsAcknowledged: row.requestsAcknowledged,
                    recordsSubmitted: row.recordsSubmitted, recordsAcknowledged: row.recordsAcknowledged,
                    acknowledgementWallMs: name === 'create' ? (allAcknowledgedMs ?? elapsedMs) : null,
                    acknowledgementMsSum: sorted.reduce((sum, value) => sum + value, 0),
                    acknowledgementMsMean: sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : null,
                    acknowledgementMsP50: percentile(0.50), acknowledgementMsP95: percentile(0.95), acknowledgementMsP99: percentile(0.99),
                    requestsPerSecond: (allAcknowledgedMs ?? elapsedMs) > 0 && name === 'create' ? row.requestsAcknowledged * 1000 / (allAcknowledgedMs ?? elapsedMs) : null,
                    recordsPerSecond: (allAcknowledgedMs ?? elapsedMs) > 0 && name === 'create' ? row.recordsAcknowledged * 1000 / (allAcknowledgedMs ?? elapsedMs) : null,
                    status: row.requestsStarted ? (row.requestsAcknowledged === row.requestsStarted ? 'complete' : 'incomplete') : 'not-run' }]
            })),
            overallThroughput: (() => {
                const rows = Object.values(crud)
                const requestsStarted = rows.reduce((sum, row) => sum + row.requestsStarted, 0)
                const requestsAcknowledged = rows.reduce((sum, row) => sum + row.requestsAcknowledged, 0)
                const recordsSubmitted = rows.reduce((sum, row) => sum + row.recordsSubmitted, 0)
                const recordsAcknowledged = rows.reduce((sum, row) => sum + row.recordsAcknowledged, 0)
                return { requestsStarted, requestsAcknowledged, recordsSubmitted, recordsAcknowledged,
                    acknowledgedRequestsPerSecond: elapsedMs > 0 ? requestsAcknowledged * 1000 / elapsedMs : 0,
                    acknowledgedRecordsPerSecond: elapsedMs > 0 ? recordsAcknowledged * 1000 / elapsedMs : 0 }
            })(),
            cpu: { averageHostBusyPercent: cpuTotal ? 100 * cpuBusy / cpuTotal : null,
                averageHostIowaitPercent: cpuTotal ? 100 * cpuIoWait / cpuTotal : null,
                accountingTicks: { total: cpuTotal, busy: cpuBusy, iowait: cpuIoWait } },
            disk: { measurement: 'all disk adapter operations during the measured lifecycle; disk drain is not awaited',
                queuedItemsAtEnd: queue.pendingDiskItems, startedOperations: io.started, completedOperations: io.completed,
                failedOperations: io.failed, inFlightOperationsAtEnd: io.inFlight,
                outstandingOperationsAtEnd: io.started - io.completed - io.failed,
                bytesSubmittedToWrites: io.bytesWritten,
                averageCompletedOpsPerSecond: elapsedMs > 0 ? io.completed * 1000 / elapsedMs : 0,
                averageStartedOpsPerSecond: elapsedMs > 0 ? io.started * 1000 / elapsedMs : 0,
                operationsByKindAndAction: io.operationCounts, samples: diskSamples },
            process: { peakRssBytes: process.resourceUsage().maxRSS * 1024, heapUsedBytes: process.memoryUsage().heapUsed }
        }
        if (!stopRequested) {
            assert.equal(acknowledgedRecords, totalRecords)
            assert.equal(queue.pendingIndexItems, 0)
        }
        process.send({ type: 'result', result, directory })
        await new Promise(resolve => process.once('message', resolve))
    } catch (caught) {
        error = caught
        process.send({ type: 'failure', failure: { message: caught.message, stack: caught.stack }, directory })
        await new Promise(resolve => process.once('message', resolve))
    } finally {
        clearInterval(sampler)
        // Do not call db.close(): it waits for the disk queue, which is outside this report's lifecycle.
        process.exit(error ? 1 : 0)
    }
}

if (process.argv.includes('--child')) await childRun()
else {
    await mkdir(output, { recursive: true })
    const status = execFileSync('git', ['status', '--short', '--untracked-files=all'], { encoding: 'utf8' }).trimEnd()
    const diff = execFileSync('git', ['diff', '--binary', 'HEAD'])
    const child = fork(script, ['--child'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env: process.env })
    const stopChild = () => { if (child.connected) child.send('stop') }
    process.once('SIGINT', stopChild)
    process.once('SIGTERM', stopChild)
    let progressWrites = Promise.resolve()
    const response = await new Promise((resolve, reject) => {
        child.once('error', reject)
        child.on('message', message => {
            if (message.type === 'result' || message.type === 'failure') resolve(message)
            if (message.type === 'progress') {
                progressWrites = progressWrites.then(() => appendFile(join(output, 'progress.ndjson'), JSON.stringify(message.sample) + '\n'))
                process.stdout.write(`BENCH_PROGRESS ${JSON.stringify(message.sample)}\n`)
            }
        })
    })
    child.send('stop')
    const exitCode = await new Promise(resolve => child.once('exit', code => resolve(code)))
    await progressWrites
    if (response.directory) await rm(response.directory, { recursive: true, force: true })
    const manifest = { runId, source: process.cwd(), baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        worktreeDirty: Boolean(status), worktreeStatus: status ? status.split('\n') : [], trackedDiffSha256: createHash('sha256').update(diff).digest('hex') }
    await writeFile(join(output, 'run-context.json'), JSON.stringify(manifest, null, 2) + '\n')
    if (response.type === 'failure') {
        const failure = { ...manifest, status: 'failed', failure: response.failure }
        await writeFile(join(output, 'result.json'), JSON.stringify(failure, null, 2) + '\n')
        throw Error(response.failure.message)
    }
    const result = { ...response.result, runContext: manifest }
    if (result.status === 'paused') {
        await writeFile(join(output, 'partial-result.json'), JSON.stringify(result, null, 2) + '\n')
        await writeFile(join(output, 'partial-report.md'), `# Paused index lifecycle\n\n` +
            `Captured after ${(result.lifecycle.wallMs / 1000).toFixed(1)} seconds. Acknowledged ${result.lifecycle.acknowledgedRecords.toLocaleString()} of ${totalRecords.toLocaleString()} planned records in ${result.crud.create.requestsAcknowledged} acknowledged create calls; ${result.lifecycle.indexQueueItemsAtEnd} index queue items and ${result.disk.queuedItemsAtEnd} disk queue items remained. ` +
            `Create acknowledgements averaged ${result.crud.create.recordsPerSecond?.toFixed(0) ?? 'n/a'} records/s up to pause. See progress.ndjson for per-second create acknowledgement and disk adapter operation rates. ` +
            `Read/update/delete phases were not part of this create/index workload. This is not an index-ready result.\n`)
        console.log(`Paused. Partial artifacts: ${output}`)
        if (exitCode !== 0) process.exitCode = exitCode ?? 1
        process.exit(0)
    }
    await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n')
    const report = `# Index-ready lifecycle: one organization, ${totalRecords.toLocaleString()} records\n\n` +
        `Status: ${result.status}. Configuration: ${primaryTreeCount} primary arrays × ${recordsPerTree.toLocaleString()} records = ${totalRecords.toLocaleString()} records. ` +
        `The measured lifecycle ends when all records are acknowledged and the index queue is empty. Disk drain was not awaited.\n\n` +
        `## Acknowledgement and indexing\n\n` +
        `- Acknowledged: ${result.lifecycle.acknowledgedRecords.toLocaleString()} records in ${result.lifecycle.acknowledgementWallMs.toFixed(2)} ms (${result.lifecycle.acknowledgedRecordsPerSecond.toFixed(0)} records/s; ${result.lifecycle.acknowledgementRequestsPerSecond.toFixed(1)} requests/s).\n` +
        `- Index-ready lifecycle: ${result.lifecycle.wallMs.toFixed(2)} ms (${result.lifecycle.indexedRecordsPerSecond.toFixed(0)} records/s); pending index items at end: ${result.lifecycle.indexQueueItemsAtEnd}.\n` +
        `- The index queue cleared ${result.lifecycle.indexTailMs.toFixed(2)} ms after the last acknowledgement returned; indexing and acknowledgement overlap, so the lifecycle wall time is the combined end-to-end measure.\n` +
        `- Acknowledgement call time summed across requests: ${result.lifecycle.acknowledgementCallTimeSumMs.toFixed(2)} ms across ${result.lifecycle.acknowledgementCalls} calls. This sum can exceed wall time because requests overlap.\n\n` +
        `- CRUD phases: ${Object.entries(result.crud).map(([name, stats]) => `${name}=${stats.status}`).join(', ')}. Per-request acknowledgement latency percentiles and counts are in result.json.\n\n` +
        `- Overall acknowledged throughput across all executed CRUD operations: ${result.overallThroughput.acknowledgedRequestsPerSecond.toFixed(1)} requests/s and ${result.overallThroughput.acknowledgedRecordsPerSecond.toFixed(0)} records/s for the entire index-ready window.\n\n` +
        `## Host CPU\n\n` +
        `- CPU: ${result.host.cpuModel}; ${result.host.physicalCores} cores × ${result.host.threadsPerCore} threads (${result.host.logicalCpus} logical CPUs), ${result.host.architecture}${result.host.virtualization ? ` on ${result.host.virtualization}` : ''}.\n` +
        `- Average host busy CPU during the measured lifecycle: ${result.cpu.averageHostBusyPercent?.toFixed(2) ?? 'n/a'}%; host iowait: ${result.cpu.averageHostIowaitPercent?.toFixed(2) ?? 'n/a'}%.\n\n` +
        `## Disk queue and file operations at index readiness\n\n` +
        `- Disk queue items outstanding: ${result.disk.queuedItemsAtEnd}; adapter operations started/completed/failed: ${result.disk.startedOperations}/${result.disk.completedOperations}/${result.disk.failedOperations}.\n` +
        `- Adapter operations still in flight: ${result.disk.inFlightOperationsAtEnd}; estimated outstanding operations: ${result.disk.outstandingOperationsAtEnd}; bytes submitted to writes: ${result.disk.bytesSubmittedToWrites.toLocaleString()}.\n` +
        `- Average adapter operation rates during lifecycle: ${result.disk.averageStartedOpsPerSecond.toFixed(1)} started/s, ${result.disk.averageCompletedOpsPerSecond.toFixed(1)} completed/s. These include all disk adapter operations; persistence notification calls are separate.\n` +
        `- Queue item count and adapter operation count are different units: pendingDiskItems counts queued Tree storage records, while adapter operations count calls into the disk adapter.\n` +
        `- Operations by kind/action: ${JSON.stringify(result.disk.operationsByKindAndAction)}. Per-second queue and I/O samples are in result.json.\n\n` +
        `Peak process RSS: ${(result.process.peakRssBytes / 1048576).toFixed(1)} MiB. Host memory: ${(result.host.totalMemoryBytes / 1073741824).toFixed(1)} GiB. Fixture SHA-256: ${result.fixtureHash}.\n\n` +
        `This is one local single-process run. Index throughput counts acknowledged records when the index queue reaches zero; it does not claim completed disk persistence.\n`
    await writeFile(join(output, 'report.md'), report)
    console.log(report)
    console.log(`Artifacts: ${output}`)
    if (exitCode !== 0) process.exitCode = exitCode ?? 1
}
