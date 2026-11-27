import { execFileSync, spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { availableParallelism, cpus, totalmem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
const outputDirectory = resolve(process.env.DB_OUTPUT_DIR ?? join(root, 'test/benchmarks/providers/cocreatedb/results', `system-capacity-${timestamp}`))
await mkdir(outputDirectory, { recursive: true })

const settings = {
    DB_SYSTEM_BENCHMARK: '1',
    DB_RECORDS: process.env.DB_RECORDS ?? '100000',
    DB_GROUPS: process.env.DB_GROUPS ?? '8',
    DB_ORGANIZATIONS: process.env.DB_ORGANIZATIONS ?? '1',
    DB_WORKERS: process.env.DB_WORKERS ?? '8',
    DB_CRUD_OPERATIONS: process.env.DB_CRUD_OPERATIONS ?? '10000',
    DB_CRUD_CONCURRENCY: process.env.DB_CRUD_CONCURRENCY ?? '32',
    DB_MIXED_MS: process.env.DB_MIXED_MS ?? '10000',
    DB_MIXED_CONCURRENCY: process.env.DB_MIXED_CONCURRENCY ?? '8',
    DB_RANDOMIZE_ARRAYS: process.env.DB_RANDOMIZE_ARRAYS ?? '0',
    DB_RESULT: join(outputDirectory, 'result.json')
}
const metadata = { benchmark: 'CoCreateDB system capacity', startedAt: new Date().toISOString(),
    node: process.version, platform: process.platform, architecture: process.arch,
    nodeOptions: process.env.NODE_OPTIONS ?? null,
    sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    workingTreeDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()),
    host: { logicalCpus: availableParallelism(), cpuModel: cpus()[0]?.model, totalMemoryBytes: totalmem() },
    settings, note: 'The runner stops after index readiness and CRUD phases; it does not wait for disk persistence to drain.' }
await writeFile(join(outputDirectory, 'run.json'), JSON.stringify(metadata, null, 2) + '\n')
const logPath = join(outputDirectory, 'progress.log')
const log = createWriteStream(logPath, { flags: 'a' })
const child = spawn(process.execPath, ['test-support/worker-db.mjs'], { cwd: root,
    env: { ...process.env, ...settings }, stdio: ['inherit', 'pipe', 'pipe'] })
child.stdout.on('data', chunk => {
    process.stdout.write(chunk)
    log.write(chunk)
})
child.stderr.on('data', chunk => {
    process.stderr.write(chunk)
    log.write(chunk)
})
const exitCode = await new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolveExit(code ?? (signal ? 1 : 0)))
})
log.end()
await new Promise(resolveLog => log.once('finish', resolveLog))
metadata.completedAt = new Date().toISOString()
metadata.exitCode = exitCode
await writeFile(join(outputDirectory, 'run.json'), JSON.stringify(metadata, null, 2) + '\n')

if (exitCode === 0) {
    const result = JSON.parse(await readFile(settings.DB_RESULT, 'utf8'))
    result.runMetadata = metadata
    await writeFile(settings.DB_RESULT, JSON.stringify(result, null, 2) + '\n')
    const metrics = result.systemMetrics
    const lines = [
        '# CoCreateDB system capacity benchmark', '',
        `- Fixture: ${result.fixtureVersion}`, `- Records: ${result.records.toLocaleString()} across ${result.organizations} organization(s), ${result.arrays} arrays, ${result.workers} workers`,
        `- Create acknowledgement: ${metrics.create.recordsPerSecond.toFixed(1)} records/s; ${metrics.create.requestLatency.p95Ms?.toFixed(2) ?? 'n/a'} ms p95 request latency`,
        `- Index drain after acknowledgements: ${metrics.create.indexDrainMs.toFixed(1)} ms`,
        `- UUID read: ${metrics.crud.uuidRead.operationsPerSecond.toFixed(1)} ops/s; p95 ${metrics.crud.uuidRead.latency.p95Ms?.toFixed(2) ?? 'n/a'} ms`,
        `- Indexed rank read: ${metrics.crud.indexedRead.operationsPerSecond.toFixed(1)} ops/s; p95 ${metrics.crud.indexedRead.latency.p95Ms?.toFixed(2) ?? 'n/a'} ms`,
        `- Update: ${metrics.crud.update.operationsPerSecond.toFixed(1)} ops/s; p95 ${metrics.crud.update.latency.p95Ms?.toFixed(2) ?? 'n/a'} ms`,
        `- Delete: ${metrics.crud.delete.operationsPerSecond.toFixed(1)} ops/s; p95 ${metrics.crud.delete.latency.p95Ms?.toFixed(2) ?? 'n/a'} ms`,
        `- Mixed CRUD: ${metrics.crud.mixed.operationsPerSecond?.toFixed(1) ?? 'n/a'} ops/s (counts: ${JSON.stringify(metrics.crud.mixed.acknowledgedByType ?? {})})`,
        `- Overall acknowledged throughput: ${metrics.overall.operationsPerSecond.toFixed(1)} requests/s`,
        `- Host average busy CPU: ${metrics.hostResources.averageBusyCpuPercent?.toFixed(1) ?? 'n/a'}% across logical CPUs`,
        `- Host average memory used: ${metrics.hostResources.averageHostMemoryUsedPercent?.toFixed(1) ?? 'n/a'}%`,
        `- Pending at endpoint: ${metrics.queueAtEnd.pendingIndexCount} index entries, ${metrics.queueAtEnd.pendingDiskCount} disk queue entries`,
        '- Disk drain: intentionally not awaited; see raw JSON for per-phase adapter operation counts, bytes and rates.', '',
        '- Persistence: test stub only; external calls and durable acknowledgement are not measured. Internal queue lock wait is not exposed by the current runtime.',
        'This result uses the versioned system fixture and is not directly comparable to the standard v3 provider benchmark.', ''
    ]
    await writeFile(join(outputDirectory, 'report.md'), lines.join('\n'))
    console.log(`System benchmark artifacts: ${outputDirectory}`)
} else {
    console.error(`System benchmark exited with code ${exitCode}; inspect ${logPath}`)
}
process.exitCode = exitCode
