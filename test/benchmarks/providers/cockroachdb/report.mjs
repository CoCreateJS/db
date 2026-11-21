import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = resolve(process.argv[2] ?? '')
if (!process.argv[2]) throw Error('Usage: node report.mjs <run-directory>')
const here = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
const runs = await Promise.all(manifest.results.filter(run => run.status === 'passed')
    .map(run => readFile(join(directory, run.file), 'utf8').then(JSON.parse)))
const median = values => {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
    if (!sorted.length) return null
    const mid = sorted.length >> 1
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
const fmt = value => value == null ? 'n/a' : Number(value).toFixed(3)
const mib = value => value == null ? 'n/a' : `${(value / 1024 / 1024).toFixed(2)} MiB`
const ops = value => value == null ? 'n/a' : `${Math.round(value).toLocaleString()} ops/s`
const opNames = ['singleCreate', 'uuidRead', 'equality', 'nestedEquality', 'numericRange', 'and', 'or', 'singleKeyUpdate', 'indexedKeyUpdate', 'numericIncrement', 'singleDelete']
const operationSummary = (sizeRuns, name) => {
    const entries = sizeRuns.map(run => run.operations?.[name]).filter(Boolean)
    return Object.fromEntries(['firstOperationMs', 'minMs', 'maxMs', 'meanMs', 'p50Ms', 'p95Ms', 'p99Ms', 'opsPerSecond'].map(key => [
        key, median(entries.map(entry => key === 'firstOperationMs' ? entry.firstOperationMs : entry.measured?.[key]))
    ]))
}
const summaries = {}
const sections = []
for (const size of [...new Set(manifest.sizes)].sort((a, b) => a - b)) {
    const sizeRuns = runs.filter(run => run.datasetSize === size)
    const failures = manifest.results.filter(run => run.size === size && run.status !== 'passed')
    const operations = Object.fromEntries(opNames.map(name => [name, operationSummary(sizeRuns, name)]))
    const sustainedGroups = new Map()
    for (const run of sizeRuns) for (const item of run.sustained ?? []) {
        const key = `${item.mode}|${item.concurrency}`
        sustainedGroups.set(key, [...(sustainedGroups.get(key) ?? []), item])
    }
    const sustained = [...sustainedGroups].map(([key, values]) => {
        const [mode, concurrency] = key.split('|')
        return {
            mode, concurrency: Number(concurrency), opsPerSecond: median(values.map(item => item.opsPerSecond)),
            p50Ms: median(values.map(item => item.latency?.p50Ms)), p95Ms: median(values.map(item => item.latency?.p95Ms)),
            p99Ms: median(values.map(item => item.latency?.p99Ms)), clientCpuPercent: median(values.map(item => item.clientCpuUtilizationPercent)),
            serverCpuPercent: median(values.map(item => item.serverCpuUtilizationPercent)), serverRssBytes: median(values.map(item => item.serverMemory?.VmRSS))
        }
    })
    const summary = {
        requestedRuns: manifest.independentRunsRequested, successfulRuns: sizeRuns.length,
        failures: failures.map(({ runIndex, status, failure, reason }) => ({ runIndex, status, failure, reason })),
        fixtureHash: sizeRuns[0]?.fixtureHash ?? null, tableSetupMs: median(sizeRuns.map(run => run.tableSetupMs)),
        indexSetupMs: median(sizeRuns.map(run => run.indexSetupMs)), firstObjectCreateMs: median(sizeRuns.map(run => run.firstObjectCreateMs)),
        createAndIndexMs: median(sizeRuns.map(run => run.createAndIndexMs)), createRecordsPerSecond: median(sizeRuns.map(run => run.createRecordsPerSecond)),
        totalElapsedMs: median(sizeRuns.map(run => run.totalElapsedMs)), operations, sustained,
        resources: {
            clientIdleRssBytes: median(sizeRuns.map(run => run.clientMemory?.idle?.rss)),
            clientLoadedRssBytes: median(sizeRuns.map(run => run.clientMemory?.loaded?.rss)),
            clientPeakRssBytes: median(sizeRuns.map(run => run.clientMemory?.peakRssBytes)),
            serverIdleRssBytes: median(sizeRuns.map(run => run.serverMemory?.idle?.VmRSS)),
            serverLoadedRssBytes: median(sizeRuns.map(run => run.serverMemory?.loaded?.VmRSS)),
            serverPeakRssBytes: median(sizeRuns.map(run => run.serverMemory?.peakRssBytes)),
            nodeStoreBytes: median(sizeRuns.map(run => run.databaseStatsFinal?.nodeStoreBytes)),
            clientCpuMs: median(sizeRuns.map(run => run.clientCpuUsageUs ? (run.clientCpuUsageUs.user + run.clientCpuUsageUs.system) / 1000 : null))
        }
    }
    summaries[size] = summary
    const opRows = Object.entries(operations).map(([name, value]) =>
        `| ${name} | ${fmt(value.firstOperationMs)} | ${fmt(value.meanMs)} | ${fmt(value.p50Ms)} | ${fmt(value.p95Ms)} | ${fmt(value.p99Ms)} | ${ops(value.opsPerSecond)} |`)
    const loadRows = sustained.map(item =>
        `| ${item.mode} | ${item.concurrency} | ${ops(item.opsPerSecond)} | ${fmt(item.p50Ms)} | ${fmt(item.p95Ms)} | ${fmt(item.p99Ms)} | ${fmt(item.clientCpuPercent)}% | ${fmt(item.serverCpuPercent)}% |`)
    const failureRows = failures.map(run => `| ${run.runIndex ?? '-'} | ${run.status} | ${run.failure?.message ?? run.reason ?? 'see manifest'} |`)
    sections.push([
        `## ${size.toLocaleString()} documents`, '',
        `- Trials: ${sizeRuns.length}/${manifest.independentRunsRequested} passed; fixture SHA-256: \`${summary.fixtureHash ?? 'n/a'}\`.`,
        `- Table setup: ${fmt(summary.tableSetupMs)} ms; secondary index setup on empty table: ${fmt(summary.indexSetupMs)} ms.`,
        `- First row create: ${fmt(summary.firstObjectCreateMs)} ms; bulk insert with indexes maintained: ${fmt(summary.createAndIndexMs)} ms (${ops(summary.createRecordsPerSecond)}).`,
        `- CockroachDB RSS idle/loaded/peak: ${mib(summary.resources.serverIdleRssBytes)} / ${mib(summary.resources.serverLoadedRssBytes)} / ${mib(summary.resources.serverPeakRssBytes)}; client Node RSS idle/loaded/peak: ${mib(summary.resources.clientIdleRssBytes)} / ${mib(summary.resources.clientLoadedRssBytes)} / ${mib(summary.resources.clientPeakRssBytes)}.`,
        `- Pebble node-store bytes (whole single-node store, not per database): ${mib(summary.resources.nodeStoreBytes)}.`, '',
        '| Operation | First ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: |', ...opRows, '',
        '| Sustained mode | Concurrency | ops/s | p50 ms | p95 ms | p99 ms | Client CPU | CockroachDB CPU |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |', ...(loadRows.length ? loadRows : ['| n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |']), '',
        '| Trial | Status | Failure / skip reason |', '| ---: | --- | --- |', ...(failureRows.length ? failureRows : ['| - | all passed | - |'])
    ].join('\n'))
}
const sourceFiles = [
    ['run.mjs', join(here, 'run.mjs')], ['prepare.mjs', join(here, 'prepare.mjs')],
    ['package.json', join(here, 'package.json')], ['package-lock.json', join(here, 'package-lock.json')],
    ['lifecycle.mjs', resolve(here, '../../../fixtures/lifecycle.mjs')]
]
const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async ([name, path]) => [name, createHash('sha256').update(await readFile(path)).digest('hex')])))
const standardized = {
    runId: manifest.runId, date: manifest.startedAt, serverVersion: manifest.serverVersionReported ?? manifest.serverVersion,
    driverVersion: manifest.driverVersion, fixtureVersion: '3.0.0', benchmarkSourceSha256: sourceHashes,
    sizes: summaries, methodology: manifest.resourcePolicy,
    failures: manifest.results.filter(run => run.status !== 'passed')
}
const providerPath = join(here, 'results/summary.json')
let provider
try { provider = JSON.parse(await readFile(providerPath, 'utf8')) }
catch { provider = { provider: 'CockroachDB', historical: null, standardized: { runs: [] } } }
provider.standardized ??= { runs: [] }
const existing = provider.standardized.runs.findIndex(run => run.runId === standardized.runId)
if (existing < 0) provider.standardized.runs.push(standardized)
else provider.standardized.runs[existing] = standardized
await writeFile(providerPath, `${JSON.stringify(provider, null, 2)}\n`)
await writeFile(join(directory, 'summary.json'), `${JSON.stringify(standardized, null, 2)}\n`)

const references = {}
for (const name of ['cocreatedb', 'mongodb', 'redis', 'couchbase', 'couchdb']) {
    try { references[name] = JSON.parse(await readFile(join(here, `../${name}/results/summary.json`), 'utf8')).standardized?.runs?.at(-1) }
    catch {}
}
const comparisons = []
for (const size of Object.keys(summaries)) for (const [name, run] of Object.entries(references)) {
    const prior = run?.sizes?.[size] ?? run?.sizes?.['json-search']?.[size]
    if (!prior) continue
    comparisons.push({ size: Number(size), provider: name, fixtureHashMatches: prior.fixtureHash === summaries[size].fixtureHash,
        runId: run.runId, createAndIndexMs: prior.createAndIndexMs,
        uuidReadP50Ms: prior.operations?.uuidRead?.p50Ms ?? prior.operations?.uuidRead?.p50,
        equalityP50Ms: prior.operations?.equality?.p50Ms ?? prior.operations?.equality?.p50,
        numericRangeP50Ms: prior.operations?.numericRange?.p50Ms ?? prior.operations?.numericRange?.p50 })
}
standardized.comparisonsToExistingLanes = comparisons
provider.standardized.runs[existing < 0 ? provider.standardized.runs.length - 1 : existing] = standardized
await writeFile(providerPath, `${JSON.stringify(provider, null, 2)}\n`)
await writeFile(join(directory, 'summary.json'), `${JSON.stringify(standardized, null, 2)}\n`)

const labels = { cocreatedb: 'CoCreateDB', mongodb: 'MongoDB', redis: 'Redis JSON/Search', couchbase: 'Couchbase', couchdb: 'CouchDB' }
const compareRows = comparisons.map(row => `| ${row.size.toLocaleString()} | ${labels[row.provider] ?? row.provider} | ${fmt(row.createAndIndexMs)} | ${fmt(row.uuidReadP50Ms)} | ${fmt(row.equalityP50Ms)} | ${fmt(row.numericRangeP50Ms)} | ${row.fixtureHashMatches ? 'yes' : 'no'} |`)
const report = [
    '# CockroachDB standardized benchmark results', '',
    `- Run ID: \`${manifest.runId}\`; ${manifest.startedAt} to ${manifest.completedAt}.`,
    `- Server build: ${manifest.serverVersionReported ?? manifest.serverVersion}; pg ${manifest.driverVersion}; source revision \`${runs[0]?.sourceRevision ?? 'unknown'}\`.`,
    `- Host: ${runs[0]?.environment?.platform ?? 'unknown'}, ${runs[0]?.environment?.cpuModel ?? 'unknown'} (${runs[0]?.environment?.cpuCount ?? '?'} logical CPUs), ${mib(runs[0]?.environment?.totalMemoryBytes)} RAM.`,
    `- ${manifest.independentRunsRequested} independent fresh databases per size; ${manifest.sampleCount} samples and ${manifest.warmupCount} warmups per operation; ${manifest.sustainedDurationMs} ms per sustained mode/concurrency.`,
    '- CockroachDB starts once as a single local node with a fresh benchmark store, stores its Pebble data in the user cache, and stops after the suite. Each trial creates and drops a separate SQL database. The single-node result does not measure distributed replication or multi-node consensus.',
    '- Documents are stored as JSONB with typed columns for the indexed fields. Five secondary indexes are created on an empty table before ingest; their maintenance happens synchronously as rows are inserted. Index setup and ingest are timed separately.',
    '- Indexed reads use CockroachDB `FORCE_INDEX` hints and retain `EXPLAIN` output. Queries return the full JSONB document; the fixture hash is computed before SQL column projection.',
    '- Updates use SQL JSONB merge plus the indexed typed-column update when needed. UUID update/delete operations use the primary key directly. CockroachDB uses the default SERIALIZABLE transaction isolation; retries are not added by the benchmark client.',
    '- Node store bytes are whole-store measurements, including CockroachDB system tables and data from trial databases; they are not isolated per-database sizes. Server RSS is the process resident set; CPU tick accounting is approximate.', '',
    '| Size | Passed | Fixture SHA-256 | Index setup ms | Bulk ingest + index work ms | Rows/s | Loaded server RSS |', '| ---: | ---: | --- | ---: | ---: | ---: | ---: |',
    ...Object.entries(summaries).map(([size, value]) => `| ${Number(size).toLocaleString()} | ${value.successfulRuns}/${value.requestedRuns} | \`${value.fixtureHash ?? 'n/a'}\` | ${fmt(value.indexSetupMs)} | ${fmt(value.createAndIndexMs)} | ${ops(value.createRecordsPerSecond)} | ${mib(value.resources.serverLoadedRssBytes)} |`), '',
    ...sections, '', '## Same-fixture reference runs', '',
    'These references are the latest stored runs, not simultaneous controlled trials. Matching fixture hashes confirm equivalent input documents; provider schemas, persistence behavior, durability, and measurement boundaries still differ.', '',
    '| Size | Provider | Create/index ms | UUID p50 ms | Equality p50 ms | Range p50 ms | Fixture match |', '| ---: | --- | ---: | ---: | ---: | ---: | --- |',
    ...(compareRows.length ? compareRows : ['| n/a | no prior runs found | n/a | n/a | n/a | n/a | n/a |']), '',
    '## Raw outputs', '',
    `Raw trial JSON, manifest, summary, and this report are stored in \`${directory}\`. Provider history appends to [summary.json](../summary.json).`
].join('\n')
await writeFile(join(directory, 'report.md'), `${report}\n`)
console.log(`report=${join(directory, 'report.md')}`)
console.log(`summary=${providerPath}`)
for (const [size, value] of Object.entries(summaries))
    console.log(`size=${size} passed=${value.successfulRuns}/${value.requestedRuns} ingest=${fmt(value.createAndIndexMs)}ms uuidReadP50=${fmt(value.operations.uuidRead.p50Ms)}ms equalityP50=${fmt(value.operations.equality.p50Ms)}ms rangeP50=${fmt(value.operations.numericRange.p50Ms)}ms`)
