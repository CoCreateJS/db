import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir, totalmem } from 'node:os'
import Disk from '@cocreate/disk'
import { createRuntime } from '../../../src/runtime.js'
import { treeContexts } from '../../../src/tree/internal.js'
import { benchmarkUuid, createBenchmarkRecord } from '../../fixtures/lifecycle.mjs'
import { nodeMemory } from '../shared/node-memory.mjs'
import { waitForIndex } from '../shared/wait-for-index.mjs'

const organizationId = process.env.BENCH_ORGANIZATION_ID ?? '000000000000000000000001'
const primaryTreeCount = Number(process.env.BENCH_PRIMARY_TREES ?? 40)
const recordsPerTree = Number(process.env.BENCH_RECORDS_PER_TREE ?? 25000)
if (!Number.isSafeInteger(primaryTreeCount) || primaryTreeCount < 3) throw Error('BENCH_PRIMARY_TREES must be an integer of at least 3')
if (!Number.isSafeInteger(recordsPerTree) || recordsPerTree < 1) throw Error('BENCH_RECORDS_PER_TREE must be a positive integer')

// Keep the first 15 trees cold; the remaining trees carry the later workload.
const coldTreeCount = Math.min(15, primaryTreeCount - 1)
const totalRecords = primaryTreeCount * recordsPerTree
const checkpoint = Math.floor(totalRecords * 2 / 3)
const activeTrees = Array.from({ length: primaryTreeCount - coldTreeCount }, (_, i) => coldTreeCount + i)
const checkpointAdds = new Map(activeTrees.map(index => [index, 0]))
let checkpointRemainder = checkpoint - coldTreeCount * recordsPerTree
for (const index of activeTrees) {
    const count = Math.min(recordsPerTree, Math.ceil(checkpointRemainder / (activeTrees.length - (index - coldTreeCount))))
    checkpointAdds.set(index, count)
    checkpointRemainder -= count
}
assert.equal(checkpointRemainder, 0)

const roots = Object.fromEntries(Array.from({ length: primaryTreeCount }, (_, i) => [`primary_${String(i + 1).padStart(2, '0')}`, {}]))
const rootNames = Object.keys(roots)
const runId = new Date().toISOString()
const output = resolve(process.env.BENCH_OUTPUT_DIR ?? `test/benchmarks/providers/cocreatedb/results/primary-pruning-${runId.replaceAll(':', '-')}`)
const worktreeStatus = execFileSync('git', ['status', '--short', '--untracked-files=all'], { encoding: 'utf8' }).trimEnd().split('\n')
const trackedDiff = execFileSync('git', ['diff', '--binary', 'HEAD'])
await mkdir(output, { recursive: true })
const directory = await mkdtemp(join(tmpdir(), 'cocreatedb-primary-pruning-'))
const result = {
    status: 'running', startedAt: runId, organizationCount: 1, primaryTreeCount,
    recordsPerPrimaryTree: recordsPerTree, totalRecords, coldTreeCount,
    phaseCheckpointRecords: checkpoint, batchSize: 1000,
    processModel: 'one organization, one Node DB process, independent top-level primary Trees, one shared disk adapter',
    rootConfiguration: roots,
    schedule: [
        { name: 'cold-tree preload', records: coldTreeCount * recordsPerTree, trees: rootNames.slice(0, coldTreeCount) },
        { name: 'two-thirds checkpoint', records: checkpoint, trees: rootNames.slice(coldTreeCount) },
        { name: 'final third', records: totalRecords - checkpoint, trees: rootNames.slice(coldTreeCount) }
    ],
    node: process.version, totalMemoryBytes: totalmem(),
    configuration: { mode: 'adaptive', memoryPolicy: 'node-wide thresholds', telemetry: 'node used-memory percentage every 100ms' },
    worktree: {
        baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        dirty: worktreeStatus.some(Boolean),
        trackedDiffSha256: createHash('sha256').update(trackedDiff).digest('hex'),
        status: worktreeStatus
    },
    primaryTrees: rootNames.map((name, index) => ({ name, index, expectedRecords: recordsPerTree, phaseRecords: [] })),
    phases: [], pruningTimeline: []
}

let db, telemetry, progress, organization, phaseName = 'initializing', acknowledgedRecords = 0
let peakResidentPrimaryTrees = 0, maximumPruneCandidates = 0
const checked = response => {
    assert.equal(response.success, true, response.error?.join('; '))
    return response
}

try {
    const disk = await Disk.init({ directory })
    const server = new EventEmitter()
    server.id = 'primary-pruning-benchmark'
    server.isPrimary = true
    db = await createRuntime(server, { disk, size: 64, roots })
    result.configuration.memory = db.config.memory
    organization = await db.organizations.get(organizationId)

    const sample = () => {
        server.emit('telemetry', { data: {
            serverId: server.id, workerId: 0, timestamp: new Date().toISOString(), memory: nodeMemory()
        } })
        peakResidentPrimaryTrees = Math.max(peakResidentPrimaryTrees, organization.trees.size)
        maximumPruneCandidates = Math.max(maximumPruneCandidates, organization.pruneCandidates.length)
        const last = result.pruningTimeline.at(-1)
        const snapshot = {
            elapsedMs: result.workStartedAt ? Math.round(performance.now() - result.workStartedAt) : 0,
            phase: phaseName, acknowledgedRecords,
            nodeUsedPercent: db.memory.nodeUsedPercent,
            pruning: db.memory.pruning,
            pruneCycles: db.memory.pruneCycles,
            treesPruned: db.memory.branchesPruned,
            residentPrimaryTrees: organization.trees.size,
            pruneCandidates: organization.pruneCandidates.length
        }
        if (!last || last.phase !== snapshot.phase || last.pruning !== snapshot.pruning ||
            last.pruneCycles !== snapshot.pruneCycles || last.residentPrimaryTrees !== snapshot.residentPrimaryTrees ||
            snapshot.elapsedMs - last.elapsedMs >= 10000 ||
            (last.acknowledgedRecords < checkpoint && snapshot.acknowledgedRecords >= checkpoint))
            result.pruningTimeline.push(snapshot)
    }
    sample()
    telemetry = setInterval(sample, 100)
    result.memory = { idle: process.memoryUsage() }
    result.workStartedAt = performance.now()
    const start = result.workStartedAt

    progress = setInterval(() => console.log(
        `BENCH_PROGRESS phase=${phaseName} elapsedMs=${Math.round(performance.now() - start)} ` +
        `acknowledged=${acknowledgedRecords}/${totalRecords} trees=${organization.trees.size}/${primaryTreeCount} ` +
        `pending=${organization.pendingIndexCount} pruning=${db.memory.pruning} pruned=${db.memory.branchesPruned} ` +
        `rssMiB=${Math.round(process.memoryUsage().rss / 1048576)}`
    ), 10000)

    const writeRange = async (treeIndex, offset, count, phase) => {
        if (!count) return
        const row = result.primaryTrees[treeIndex]
        const target = row.name
        const hash = createHash('sha256')
        const phaseStart = performance.now()
        let acknowledged = 0
        for (let batchOffset = 0; batchOffset < count; batchOffset += 1000) {
            const size = Math.min(1000, count - batchOffset)
            const baseRank = treeIndex * recordsPerTree + offset + batchOffset
            const values = Array.from({ length: size }, (_, i) => createBenchmarkRecord(baseRank + i, totalRecords, organizationId))
            const generation = performance.now()
            hash.update(JSON.stringify(values))
            row.fixtureGenerationMs = (row.fixtureGenerationMs ?? 0) + performance.now() - generation
            const before = performance.now()
            const response = checked(await db.send({ organization_id: organizationId, method: `${target}.create`, [target]: values }))
            row.acknowledgementMs = (row.acknowledgementMs ?? 0) + performance.now() - before
            assert.equal(response[target].length, size)
            acknowledged += size
            acknowledgedRecords += size
        }
        const phaseResult = {
            name: phase, records: count, offset, fixtureHash: hash.digest('hex'),
            elapsedMs: performance.now() - phaseStart
        }
        row.phaseRecords.push(phaseResult)
        row.recordsWritten = (row.recordsWritten ?? 0) + count
    }

    const runPhase = async (name, work) => {
        phaseName = name
        const beforeRecords = acknowledgedRecords
        const before = performance.now()
        await Promise.all(work.map(([treeIndex, offset, count]) => writeRange(treeIndex, offset, count, name)))
        const phase = {
            name, records: acknowledgedRecords - beforeRecords,
            acknowledgedAtRecords: acknowledgedRecords,
            elapsedMs: performance.now() - before
        }
        result.phases.push(phase)
        console.log(`BENCH_PHASE ${JSON.stringify(phase)}`)
        return phase
    }

    await runPhase('cold-tree preload', Array.from({ length: coldTreeCount }, (_, i) => [i, 0, recordsPerTree]))
    phaseName = 'cold-tree index drain'
    await waitForIndex(organization, { timeoutMs: 1200000, progressMs: 10000 })
    result.coldTreeDrainPending = organization.pendingIndexCount
    result.coldTreesIdleSinceRecords = acknowledgedRecords

    await runPhase('two-thirds checkpoint', activeTrees.map(index => [index, 0, checkpointAdds.get(index)]))
    assert.equal(acknowledgedRecords, checkpoint)
    phaseName = 'two-thirds checkpoint index drain'
    await waitForIndex(organization, { timeoutMs: 1200000, progressMs: 10000 })
    result.checkpointPending = organization.pendingIndexCount
    result.checkpointTreesResident = organization.trees.size
    result.checkpointTreesPruned = db.memory.branchesPruned

    await runPhase('final third', activeTrees.map(index => [index, checkpointAdds.get(index), recordsPerTree - checkpointAdds.get(index)]))
    assert.equal(acknowledgedRecords, totalRecords)
    phaseName = 'final index drain'
    await waitForIndex(organization, { timeoutMs: 1200000, progressMs: 10000 })
    result.createAndIndexMs = performance.now() - start
    result.recordsPerSecond = totalRecords / result.createAndIndexMs * 1000
    result.pendingBeforeReadChecks = organization.pendingIndexCount
    result.residentPrimaryTreesAtIngestEnd = organization.trees.size
    result.primaryTreesPrunedAtIngestEnd = db.memory.branchesPruned
    result.peakResidentPrimaryTrees = peakResidentPrimaryTrees
    result.maximumPruneCandidates = maximumPruneCandidates
    result.memory.loaded = process.memoryUsage()
    result.memory.peakRssBytes = process.resourceUsage().maxRSS * 1024
    clearInterval(progress)

    phaseName = 'read validation'
    for (const row of result.primaryTrees) {
        const firstUuid = benchmarkUuid(row.index * recordsPerTree)
        const direct = checked(await db.send({ organization_id: organizationId, method: `${row.name}.read`, [row.name]: { uuid: firstUuid } }))
        assert.equal(direct[row.name].length, 1)
        const indexed = checked(await db.send({ organization_id: organizationId, method: `${row.name}.read`, filter: { query: { group: 'group-3' }, limit: 100 } }))
        assert.equal(indexed[row.name].length, 100)
        assert.ok(indexed[row.name].every(leaf => leaf.organization_id === organizationId && leaf.group === 'group-3'))
        row.uuidRead = 'passed'
        row.indexedRead = 'passed'
    }
    result.primaryTreeCountObserved = Object.keys(organization.config.top).length
    result.livePrimaryTreesAfterValidation = organization.trees.size
    assert.equal(result.primaryTreeCountObserved, primaryTreeCount)
    assert.equal(result.primaryTrees.reduce((sum, tree) => sum + tree.recordsWritten, 0), totalRecords)
    result.pendingAfterReadChecks = organization.pendingIndexCount
    result.telemetry = { ...db.memory }
    result.correctness = {
        exactlyOneMillionRecords: true,
        oneOrganization: true,
        primaryTreeCountMatched: true,
        allPrimaryTreeUuidReads: 'passed',
        allPrimaryTreeIndexedReads: 'passed'
    }
    await db.close()
    db = undefined
    result.status = 'passed'
} catch (error) {
    result.status = 'failed'
    result.failure = { message: error.message, stack: error.stack }
    process.exitCode = 1
} finally {
    clearInterval(telemetry)
    clearInterval(progress)
    if (db) await db.close().catch(error => { result.closeError = error.message })
    result.completedAt = new Date().toISOString()
    await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n')
    const report = `# One organization, one million records with natural primary-tree pruning\n\n` +
        `Status: ${result.status}. One organization, ${primaryTreeCount} primary trees, ${recordsPerTree.toLocaleString()} records each (${totalRecords.toLocaleString()} total). ` +
        `Cold set: first ${coldTreeCount} trees (${(coldTreeCount * recordsPerTree).toLocaleString()} records) filled and indexed before writes move to the remaining ${primaryTreeCount - coldTreeCount}. ` +
        `At the two-thirds checkpoint (${checkpoint.toLocaleString()} records), writes remain on that active subset. No prune call is made by the benchmark.\n\n` +
        `Create + index wall time: ${result.createAndIndexMs ? (result.createAndIndexMs / 1000).toFixed(2) : 'n/a'} s. ` +
        `Throughput: ${result.recordsPerSecond?.toFixed(0) ?? 'n/a'} records/s. ` +
        `Peak process RSS: ${result.memory?.peakRssBytes ? (result.memory.peakRssBytes / 1048576).toFixed(1) : 'n/a'} MiB.\n\n` +
        `Natural pruning triggered: ${result.telemetry?.pruneCycles > 0 ? 'yes' : 'no'}. ` +
        `Trees pruned by ingest end: ${result.primaryTreesPrunedAtIngestEnd ?? 'n/a'}. ` +
        `Peak Node memory: ${result.telemetry?.peakNodeUsedPercent?.toFixed(2) ?? 'n/a'}%. ` +
        `Pending before validation: ${result.pendingBeforeReadChecks ?? 'n/a'}.\n\n` +
        `| Phase | Records | Cumulative acknowledged | Elapsed (s) |\n| --- | ---: | ---: | ---: |\n` +
        `${result.phases.map(phase => `| ${phase.name} | ${phase.records} | ${phase.acknowledgedAtRecords} | ${(phase.elapsedMs / 1000).toFixed(2)} |`).join('\n')}\n\n` +
        `Correctness: ${JSON.stringify(result.correctness ?? result.failure)}.\n`
    await writeFile(join(output, 'report.md'), report)
    await rm(directory, { recursive: true, force: true })
}

console.log(JSON.stringify({
    status: result.status, totalRecords, primaryTreeCount,
    createAndIndexMs: result.createAndIndexMs, recordsPerSecond: result.recordsPerSecond,
    pruningCycles: result.telemetry?.pruneCycles, treesPruned: result.primaryTreesPrunedAtIngestEnd,
    output, failure: result.failure
}))
