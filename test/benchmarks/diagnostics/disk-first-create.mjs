import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { availableParallelism, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import createDB from '../../../src/index.js'
import { lifecycleRoot } from '../../fixtures/lifecycle.mjs'
import { createResidencyRecord } from './fixtures/residency.mjs'

const { values } = parseArgs({ options: {
    acknowledgement: { type: 'string', default: 'memory' },
    records: { type: 'string', default: '10000' },
    'batch-size': { type: 'string', default: '250' }
} })
const acknowledgement = values.acknowledgement
const records = Number(values.records)
const batchSize = Number(values['batch-size'])
assert.ok(['memory', 'disk'].includes(acknowledgement), '--acknowledgement must be memory or disk')
assert.ok(Number.isSafeInteger(records) && records >= 1, '--records must be a positive integer')
assert.ok(Number.isSafeInteger(batchSize) && batchSize >= 1, '--batch-size must be a positive integer')

const startedAt = new Date()
const outputDir = resolve(process.env.BENCH_OUTPUT_DIR ?? 'test/benchmarks/diagnostics/results')
const sizeLabel = records >= 1000 && records % 1000 === 0 ? `${records / 1000}k` : String(records)
const outputFile = join(outputDir, `disk-first-create-${sizeLabel}-${acknowledgement}-${startedAt.toISOString().replaceAll(':', '-')}.json`)
const directory = await mkdtemp(join(tmpdir(), `cocreatedb-disk-first-${acknowledgement}-`))
const root = lifecycleRoot(records)
const db = await createDB({}, { directory, deferIndex: false, memoryPolicy: false, mode: 'disk-first', acknowledgement })
const started = performance.now()
const result = {
    benchmark: 'cocreatedb-disk-first-create-diagnostic',
    benchmarkVersion: 1,
    fixture: 'residency diagnostic fixture v1',
    fixtureVersion: 1,
    startedAt: startedAt.toISOString(),
    sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceWorkingTreeDirty: true,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    cpuCount: availableParallelism(),
    databaseMode: 'disk-first',
    acknowledgement,
    datasetSize: records,
    batchSize,
    requests: Math.ceil(records / batchSize),
    status: 'running'
}

try {
    for (let offset = 0; offset < records; offset += batchSize) {
        const end = Math.min(records, offset + batchSize)
        const object = Array.from({ length: end - offset }, (_, index) =>
            createResidencyRecord(offset + index, records, root.organization_id))
        const response = await db.send({ ...root, method: 'object.create', object })
        assert.equal(response.success, true, JSON.stringify(response.error))
        assert.equal(response.object.length, object.length)
    }
    await db.flushIndex()
    await db.flushDisk()
    result.createAndIndexMs = performance.now() - started
    result.peakRssMiB = process.resourceUsage().maxRSS / 1024
    result.leafFiles = db.leafTier.warm.size
    result.structuralLeafFiles = Object.keys(db.config.leaves).length
    result.objectLeafFiles = result.leafFiles - result.structuralLeafFiles
    result.branchFiles = db.local.warmBranches.size
    result.leafWrites = db.leafTier.writes
    result.branchWrites = db.local.writes
    result.pendingIndex = db.pendingIndexCount
    assert.equal(result.objectLeafFiles, records)
    assert.equal(result.pendingIndex, 0)
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
