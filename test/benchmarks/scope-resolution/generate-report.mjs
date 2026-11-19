import { readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = dirname(fileURLToPath(import.meta.url))
const readJson = async file => JSON.parse(await readFile(file, 'utf8'))
const beforeFile = (await readdir(join(directory, 'before'))).find(file => file.endsWith('.json'))
const afterFiles = (await readdir(join(directory, 'after'))).filter(file => file.endsWith('.json')).sort()
const beforeRun = await readJson(join(directory, 'before', beforeFile))
const afterRuns = await Promise.all(afterFiles.map(file => readJson(join(directory, 'after', file))))
const baseline = beforeRun.sizes[0]
const nextRuns = afterRuns.map(run => run.sizes[0])
if (!nextRuns.length || nextRuns.some(run => run.size !== baseline.size || run.fixtureHash !== baseline.fixtureHash))
    throw Error('Benchmark fixture mismatch')
const average = values => values.reduce((sum, value) => sum + value, 0) / values.length
const after = key => average(nextRuns.map(run => run[key]))
const read = key => ({
    cold: average(nextRuns.map(run => run[key].coldMs)),
    p50: average(nextRuns.map(run => run[key].p50Ms)),
    p95: average(nextRuns.map(run => run[key].p95Ms)),
    p99: average(nextRuns.map(run => run[key].p99Ms)),
    ops: average(nextRuns.map(run => run[key].opsPerSecond))
})
const baselineRead = key => baseline[key]
const ms = value => `${value.toFixed(3)} ms`
const ops = value => `${Math.round(value).toLocaleString()} ops/s`
const percent = (oldValue, newValue) => `${((newValue / oldValue - 1) * 100 >= 0 ? '+' : '')}${((newValue / oldValue - 1) * 100).toFixed(1)}%`
const rows = []
const add = (name, oldValue, newValue, format = ms) => rows.push(`| ${name} | ${format(oldValue)} | ${format(newValue)} | ${percent(oldValue, newValue)} |`)
add('Create + index, 1,000 records', baseline.createBatchMs, after('createBatchMs'))
add('Create throughput', baseline.createRecordsPerSecond, after('createRecordsPerSecond'), ops)
for (const [label, key] of [['UUID read', 'readUuid'], ['Equality read', 'readEquality'], ['Nested path read', 'readNestedPath'], ['Range read', 'readRange'], ['UUID update', 'updateUuid']]) {
    const old = baselineRead(key), current = read(key)
    add(`${label} cold`, old.coldMs, current.cold)
    add(`${label} warm p50`, old.p50Ms, current.p50)
    add(`${label} warm p95`, old.p95Ms, current.p95)
    add(`${label} warm p99`, old.p99Ms, current.p99)
    add(`${label} warm throughput`, old.opsPerSecond, current.ops, ops)
}
add('Delete batch, 25 records', baseline.deleteBatch.elapsedMs, average(nextRuns.map(run => run.deleteBatch.elapsedMs)))
add('Process CPU user + system', baseline.cpuUsageUs.user + baseline.cpuUsageUs.system,
    average(nextRuns.map(run => run.cpuUsageUs.user + run.cpuUsageUs.system)), value => `${(value / 1000).toFixed(1)} ms`)
add('Heap used after workload', baseline.memory.heapUsed, average(nextRuns.map(run => run.memory.heapUsed)), value => `${(value / 1024 / 1024).toFixed(2)} MiB`)
add('RSS after workload', baseline.memory.rss, average(nextRuns.map(run => run.memory.rss)), value => `${(value / 1024 / 1024).toFixed(2)} MiB`)
const afterLinks = afterFiles.map(file => `[${file}](after/${file})`).join(', ')
const report = [
    '# CoCreateDB configurable scope benchmark', '',
    `- Workload: lifecycle fixture v2, ${baseline.size.toLocaleString()} records; ${beforeRun.samples} measured samples per operation after 10 warmups.`,
    `- Fixture SHA-256: \`${baseline.fixtureHash}\``,
    `- Runtime: ${beforeRun.node} on ${beforeRun.platform}; ${beforeRun.cpuCount} CPUs reported.`,
    `- Before source: \`${(await readFile(join(directory, 'before/source.txt'), 'utf8')).trim()}\`; after source: \`${(await readFile(join(directory, 'after/source.txt'), 'utf8')).trim()}\`.`,
    `- After results are averaged across ${afterRuns.length} identical runs.`,
    `- Raw JSON: [before](before/${beforeFile}); after: ${afterLinks}.`, '',
    '| Metric | Before | Scoped implementation | Change |', '| --- | ---: | ---: | ---: |', ...rows, '',
    '## Interpretation', '',
    'Both versions use the same fixture hash, record count, query predicates, and benchmark script. The baseline is the pre-scope Next prototype. The scoped version resolves configured parent artifacts before running CRUD and indexes scope relationships, which adds work to each request. Latencies increased in this run series, especially UUID reads; the comparison makes that cost visible for review.',
    '',
    'CPU and memory are process-level readings after each workload and vary with runtime garbage collection and host load. These are in-memory prototype measurements; peer distribution and durable persistence remain outside the benchmark. The report does not treat the timing changes as a correctness or production-performance claim.', ''
].join('\n')
await writeFile(join(directory, 'report.md'), report)
console.log(`report=${resolve(directory, 'report.md')}`)
