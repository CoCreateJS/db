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
const operationsList = ['singleCreate', 'uuidRead', 'equality', 'nestedEquality', 'numericRange', 'and', 'or', 'singleKeyUpdate', 'indexedKeyUpdate', 'numericIncrement', 'singleDelete']
const summarizeOperation = (sizeRuns, name) => {
    const measurements = sizeRuns.map(run => run.operations?.[name]).filter(Boolean)
    return Object.fromEntries(['firstOperationMs', 'minMs', 'maxMs', 'meanMs', 'p50Ms', 'p95Ms', 'p99Ms', 'opsPerSecond'].map(field => [
        field, median(measurements.map(value => field === 'firstOperationMs' ? value.firstOperationMs : value.measured?.[field]))
    ]))
}
const sizes = [...new Set(manifest.sizes)].sort((a, b) => a - b)
const summaries = {}
const sections = []
for (const size of sizes) {
    const sizeRuns = runs.filter(run => run.datasetSize === size)
    const failures = manifest.results.filter(run => run.size === size && run.status !== 'passed')
    const operations = Object.fromEntries(operationsList.map(name => [name, summarizeOperation(sizeRuns, name)]))
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
            serverCpuPercent: median(values.map(item => item.serverCpuUtilizationPercent)), serverRssBytes: median(values.map(item => item.serverMemory?.rssBytes))
        }
    })
    const summary = {
        requestedRuns: manifest.independentRunsRequested, successfulRuns: sizeRuns.length,
        failures: failures.map(({ runIndex, status, failure, reason }) => ({ runIndex, status, failure, reason })),
        fixtureHash: sizeRuns[0]?.fixtureHash ?? null,
        indexSetupMs: median(sizeRuns.map(run => run.indexSetupMs)), indexCatchupMs: median(sizeRuns.map(run => run.indexCatchupMs)),
        firstObjectCreateMs: median(sizeRuns.map(run => run.firstObjectCreateMs)),
        createAndIndexMs: median(sizeRuns.map(run => run.createAndIndexMs)),
        createRecordsPerSecond: median(sizeRuns.map(run => run.createRecordsPerSecond)),
        totalElapsedMs: median(sizeRuns.map(run => run.totalElapsedMs)), operations, sustained,
        resources: {
            clientIdleRssBytes: median(sizeRuns.map(run => run.clientMemory?.idle?.rss)),
            clientLoadedRssBytes: median(sizeRuns.map(run => run.clientMemory?.loaded?.rss)),
            clientPeakRssBytes: median(sizeRuns.map(run => run.clientMemory?.peakRssBytes)),
            serverIdleRssBytes: median(sizeRuns.map(run => run.serverMemory?.idle?.rssBytes)),
            serverLoadedRssBytes: median(sizeRuns.map(run => run.serverMemory?.loaded?.rssBytes)),
            serverPeakRssBytes: median(sizeRuns.map(run => run.serverMemory?.peakRssBytes)),
            databaseBytes: median(sizeRuns.map(run => run.databaseStatsFinal?.diskSizeBytes)),
            clientCpuMs: median(sizeRuns.map(run => run.clientCpuUsageUs ? (run.clientCpuUsageUs.user + run.clientCpuUsageUs.system) / 1000 : null))
        }
    }
    summaries[size] = summary
    const operationRows = Object.entries(operations).map(([name, value]) =>
        `| ${name} | ${fmt(value.firstOperationMs)} | ${fmt(value.meanMs)} | ${fmt(value.p50Ms)} | ${fmt(value.p95Ms)} | ${fmt(value.p99Ms)} | ${ops(value.opsPerSecond)} |`)
    const sustainedRows = sustained.map(item =>
        `| ${item.mode} | ${item.concurrency} | ${ops(item.opsPerSecond)} | ${fmt(item.p50Ms)} | ${fmt(item.p95Ms)} | ${fmt(item.p99Ms)} | ${fmt(item.clientCpuPercent)}% | ${fmt(item.serverCpuPercent)}% |`)
    sections.push([
        `## ${size.toLocaleString()} documents`, '',
        `- Independent runs: ${sizeRuns.length}/${manifest.independentRunsRequested}; fixture SHA-256: \`${summary.fixtureHash ?? 'n/a'}\`.`,
        `- Index setup: ${fmt(summary.indexSetupMs)} ms; index catch-up after bulk ingest: ${fmt(summary.indexCatchupMs)} ms.`,
        `- First document create: ${fmt(summary.firstObjectCreateMs)} ms; bulk create plus concurrent index maintenance: ${fmt(summary.createAndIndexMs)} ms (${ops(summary.createRecordsPerSecond)}).`,
        `- CouchDB RSS idle/loaded/peak: ${mib(summary.resources.serverIdleRssBytes)} / ${mib(summary.resources.serverLoadedRssBytes)} / ${mib(summary.resources.serverPeakRssBytes)}; client Node RSS idle/loaded/peak: ${mib(summary.resources.clientIdleRssBytes)} / ${mib(summary.resources.clientLoadedRssBytes)} / ${mib(summary.resources.clientPeakRssBytes)}.`,
        `- Final database disk size: ${mib(summary.resources.databaseBytes)}.`, '',
        '| Operation | First ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: |', ...operationRows, '',
        '| Sustained workload | Concurrency | ops/s | p50 ms | p95 ms | p99 ms | Client CPU | CouchDB CPU |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |', ...(sustainedRows.length ? sustainedRows : ['| n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |']), '',
        '| Run | Status | Failure / skip reason |', '| ---: | --- | --- |', ...(failures.length ? failures.map(run => `| ${run.runIndex ?? '-'} | ${run.status} | ${run.failure?.message ?? run.reason ?? 'see manifest'} |`) : ['| - | all passed | - |'])
    ].join('\n'))
}

const sourceFiles = [
    ['run.mjs', join(here, 'run.mjs')], ['prepare.mjs', join(here, 'prepare.mjs')],
    ['package.json', join(here, 'package.json')], ['lifecycle.mjs', resolve(here, '../../../fixtures/lifecycle.mjs')]
]
const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async ([name, path]) => [name, createHash('sha256').update(await readFile(path)).digest('hex')])))
const standardized = {
    runId: manifest.runId, date: manifest.startedAt, serverVersion: manifest.serverVersion,
    fixtureVersion: '3.0.0', benchmarkSourceSha256: sourceHashes, sizes: summaries,
    methodology: manifest.resourcePolicy, failures: manifest.results.filter(run => run.status !== 'passed')
}
const providerPath = join(here, 'results/summary.json')
let provider
try { provider = JSON.parse(await readFile(providerPath, 'utf8')) }
catch { provider = { provider: 'Apache CouchDB', historical: null, standardized: { runs: [] } } }
provider.standardized ??= { runs: [] }
const duplicate = provider.standardized.runs.findIndex(run => run.runId === standardized.runId)
if (duplicate < 0) provider.standardized.runs.push(standardized)
else provider.standardized.runs[duplicate] = standardized
await writeFile(providerPath, `${JSON.stringify(provider, null, 2)}\n`)
await writeFile(join(directory, 'summary.json'), `${JSON.stringify(standardized, null, 2)}\n`)

const comparison = []
const references = {}
for (const name of ['cocreatedb', 'mongodb', 'redis', 'couchbase']) {
    try { references[name] = JSON.parse(await readFile(join(here, `../${name}/results/summary.json`), 'utf8')).standardized?.runs?.at(-1) }
    catch {}
}
for (const size of sizes) for (const [name, reference] of Object.entries(references)) {
    const prior = reference?.sizes?.[size] ?? reference?.sizes?.['json-search']?.[size]
    if (!prior) continue
    comparison.push({
        size, provider: name, fixtureHashMatches: prior.fixtureHash === summaries[size].fixtureHash,
        runId: reference.runId, createAndIndexMs: prior.createAndIndexMs,
        uuidReadP50Ms: prior.operations?.uuidRead?.p50Ms ?? prior.operations?.uuidRead?.p50,
        equalityP50Ms: prior.operations?.equality?.p50Ms ?? prior.operations?.equality?.p50,
        numericRangeP50Ms: prior.operations?.numericRange?.p50Ms ?? prior.operations?.numericRange?.p50
    })
}
standardized.comparisonsToExistingLanes = comparison
provider.standardized.runs[duplicate < 0 ? provider.standardized.runs.length - 1 : duplicate] = standardized
await writeFile(providerPath, `${JSON.stringify(provider, null, 2)}\n`)
await writeFile(join(directory, 'summary.json'), `${JSON.stringify(standardized, null, 2)}\n`)
const labels = { cocreatedb: 'CoCreateDB', mongodb: 'MongoDB', redis: 'Redis JSON/Search', couchbase: 'Couchbase' }
const comparisonRows = comparison.map(row => `| ${row.size.toLocaleString()} | ${labels[row.provider] ?? row.provider} | ${fmt(row.createAndIndexMs)} | ${fmt(row.uuidReadP50Ms)} | ${fmt(row.equalityP50Ms)} | ${fmt(row.numericRangeP50Ms)} | ${row.fixtureHashMatches ? 'yes' : 'no'} |`)
const report = [
    '# CouchDB standardized benchmark results', '',
    `- Run ID: \`${manifest.runId}\`; ${manifest.startedAt} to ${manifest.completedAt}.`,
    `- CouchDB ${manifest.serverVersionReported ?? manifest.serverVersion}; Node ${runs[0]?.environment?.node ?? process.version}; source revision \`${runs[0]?.sourceRevision ?? 'unknown'}\`.`,
    `- Host: ${runs[0]?.environment?.platform ?? 'unknown'}, ${runs[0]?.environment?.cpuModel ?? 'unknown'} (${runs[0]?.environment?.cpuCount ?? '?'} logical CPUs), ${mib(runs[0]?.environment?.totalMemoryBytes)} RAM.`,
    `- ${manifest.independentRunsRequested} independent fresh databases per size; ${manifest.sampleCount} measured samples and ${manifest.warmupCount} warmups; ${manifest.sustainedDurationMs} ms per sustained mode/concurrency.`,
    `- Process model: ${runs[0]?.environment?.processModel ?? 'n/a'}. The server starts once, the trial databases are created/deleted per run, and the local server is stopped after the suite.`,
    '- A single seed document is used for first-create and index warmup measurements. Fixture records are bulk inserted in batches of 1,000, with Mango indexes defined before ingest. Index creation/setup, bulk-ingest index catch-up, and ingest time are reported separately.',
    '- CouchDB document `_id` is reserved for the database document key, so it equals fixture `uuid`; the fixture application `_id` is stored as `appId`. Updates GET the current revision then PUT the full document; deletes likewise require the latest `_rev`. This measures CouchDB MVCC request costs.',
    '- Indexed Mango reads pin the intended JSON index with `use_index` and `allow_fallback:false`; correctness checks compare UUID results with the shared fixture expectations. CouchDB rejects the forced compound index for the `$or` query, so that case uses the normal planner and its `_explain` plan shows `_all_docs` (a full scan). Raw plans are retained.',
    '- Server CPU is approximate process tick accounting; server RSS sums CouchDB processes and may double-count shared pages. Disk size is CouchDB database reported size; filesystem-wide and index-directory sizes are in raw data only when separately available.', '',
    '| Size | Passed | Fixture SHA-256 | Index setup ms | Catch-up ms | Bulk ingest + index maintenance ms | Records/s | CouchDB loaded RSS |',
    '| ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |',
    ...Object.entries(summaries).map(([size, value]) => `| ${Number(size).toLocaleString()} | ${value.successfulRuns}/${value.requestedRuns} | \`${value.fixtureHash ?? 'n/a'}\` | ${fmt(value.indexSetupMs)} | ${fmt(value.indexCatchupMs)} | ${fmt(value.createAndIndexMs)} | ${ops(value.createRecordsPerSecond)} | ${mib(value.resources.serverLoadedRssBytes)} |`), '',
    ...sections, '', '## Same-fixture reference runs', '',
    'These are the latest stored provider runs, not simultaneous trials. Matching fixture hashes are shown; configurations, index timing boundaries, durability, and run times differ, so treat this as context rather than a controlled ranking.', '',
    '| Size | Provider | Create + index ms | UUID p50 ms | Equality p50 ms | Range p50 ms | Fixture match |', '| ---: | --- | ---: | ---: | ---: | ---: | --- |',
    ...(comparisonRows.length ? comparisonRows : ['| n/a | no prior runs found | n/a | n/a | n/a | n/a | n/a |']), '',
    '## Raw outputs', '',
    `Raw run JSON, manifest, summary, and this report are in \`${directory}\`. The append-only provider history is [summary.json](../summary.json).`,
    'The lane is standalone and loopback-only. It does not measure replication, clustered failover, remote network behavior, or multi-node consistency. The `$or` result timing includes the provider’s full-scan plan and is not an indexed-query comparison.'
].join('\n')
await writeFile(join(directory, 'report.md'), `${report}\n`)
console.log(`report=${join(directory, 'report.md')}`)
console.log(`summary=${providerPath}`)
for (const [size, value] of Object.entries(summaries)) console.log(`size=${size} passed=${value.successfulRuns}/${value.requestedRuns} ingest=${fmt(value.createAndIndexMs)}ms uuidReadP50=${fmt(value.operations.uuidRead.p50Ms)}ms equalityP50=${fmt(value.operations.equality.p50Ms)}ms rangeP50=${fmt(value.operations.numericRange.p50Ms)}ms`)
