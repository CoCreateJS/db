import { waitForIndex } from '../shared/wait-for-index.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { availableParallelism, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createRuntime } from '../../../src/runtime.js'
import { lifecycleRoot } from '../../fixtures/lifecycle.mjs'
import { createResidencyRecord } from './fixtures/residency.mjs'

const { values } = parseArgs({ options: {
    records: { type: 'string', default: '10000' },
    'batch-size': { type: 'string', default: '250' }
} })
const records = Number(values.records)
const batchSize = Number(values['batch-size'])
assert.ok(Number.isSafeInteger(records) && records >= 1, '--records must be a positive integer')
assert.ok(Number.isSafeInteger(batchSize) && batchSize >= 1, '--batch-size must be a positive integer')

const startedAt = new Date()
const outputDir = resolve(process.env.BENCH_OUTPUT_DIR ?? 'test/benchmarks/diagnostics/results')
const sizeLabel = records >= 1000 && records % 1000 === 0 ? `${records / 1000}k` : String(records)
const outputFile = join(outputDir, `adaptive-create-${sizeLabel}-${startedAt.toISOString().replaceAll(':', '-')}.json`)
const directory = await mkdtemp(join(tmpdir(), 'cocreatedb-adaptive-create-'))
const root = lifecycleRoot(records)
// Intentionally pass no mode, acknowledgement, memory-policy, or indexing options.
const db = await createRuntime({}, { directory })
const result = {
    benchmark: 'cocreatedb-adaptive-default-create-diagnostic',
    benchmarkVersion: 1,
    fixture: 'residency diagnostic fixture v1',
    fixtureVersion: 1,
    startedAt: startedAt.toISOString(),
    sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceWorkingTreeDirty: true,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    cpuCount: availableParallelism(),
    databaseMode: db.mode,
    effectiveModeAtStart: db.effectiveMode,
    acknowledgement: db.acknowledgement,
    datasetSize: records,
    batchSize,
    requests: Math.ceil(records / batchSize),
    status: 'running'
}
const started = performance.now()
let preparationMs = 0
let acknowledgementMs = 0

try {
    for (let offset = 0; offset < records; offset += batchSize) {
        const end = Math.min(records, offset + batchSize)
        const prepareStart = performance.now()
        const object = Array.from({ length: end - offset }, (_, index) =>
            createResidencyRecord(offset + index, records, root.organization_id))
        preparationMs += performance.now() - prepareStart

        const requestStart = performance.now()
        const response = await db.send({ ...root, method: 'object.create', object })
        acknowledgementMs += performance.now() - requestStart
        assert.equal(response.success, true, JSON.stringify(response.error))
        assert.equal(response.object.length, object.length)

        if (end % 10000 === 0 || end === records) {
            const mode = db.effectiveMode
            process.stdout.write(`progress=${end}/${records} rssMiB=${(process.memoryUsage.rss() / 1048576).toFixed(1)} effectiveMode=${mode} pendingIndex=${db.pendingIndexCount}\n`)
        }
    }
    result.createAcknowledgementMs = performance.now() - started
    result.fixturePreparationMs = preparationMs
    result.requestAcknowledgementMs = acknowledgementMs
    result.pendingIndexBeforeDrain = db.pendingIndexCount
    result.effectiveModeBeforeDrain = db.effectiveMode
    result.peakRssBeforeDrainMiB = process.resourceUsage().maxRSS / 1024

    const indexStart = performance.now()
    await waitForIndex(db)
    result.indexDrainMs = performance.now() - indexStart
    result.pendingIndexAfterDrain = db.pendingIndexCount

    const diskStart = performance.now()
    await waitForIndex(db)
    result.diskDrainMs = performance.now() - diskStart
    result.fullElapsedMs = performance.now() - started
    result.effectiveModeAtEnd = db.effectiveMode
    result.peakRssMiB = process.resourceUsage().maxRSS / 1024
    result.residentLeaves = db.leafTier.size
    result.warmLeafFiles = db.leafTier.warm.size
    result.totalLeafFiles = db.leafTier.totalSize
    result.branchFiles = db.local.warmBranches.size
    result.leafWrites = db.leafTier.writes
    result.branchWrites = db.local.writes
    result.memoryPolicy = { ...db.memory }
    const leafFiles = await readdir(join(directory, 'leaves'))
    result.objectLeafFilesOnDisk = leafFiles.filter(name => name.endsWith('.json')).length - Object.keys(db.config.leaves).length
    assert.equal(result.totalLeafFiles, records + Object.keys(db.config.leaves).length)
    assert.equal(result.pendingIndexAfterDrain, 0)
    result.status = 'passed'
} catch (error) {
    result.status = 'failed'
    result.failure = { name: error.name, message: error.message, stack: error.stack }
} finally {
    result.completedAt = new Date().toISOString()
    await mkdir(outputDir, { recursive: true })
    await writeFile(outputFile, `${JSON.stringify(result, null, 2)}\n`)
    await rm(directory, { recursive: true, force: true })
    process.stdout.write(`result=${outputFile}\n`)
}

if (result.status !== 'passed') process.exitCode = 1
