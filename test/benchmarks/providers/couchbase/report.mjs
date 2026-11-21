import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = resolve(process.argv[2] ?? '')
if (!process.argv[2]) throw Error('Usage: node report.mjs <run-directory>')
const here = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
const rawRuns = await Promise.all(manifest.results.filter(run => run.status === 'passed')
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
const sourceFiles = [
    ['test/benchmarks/providers/couchbase/run.mjs', join(here, 'run.mjs')],
    ['test/benchmarks/providers/couchbase/package.json', join(here, 'package.json')],
    ['test/benchmarks/providers/couchbase/package-lock.json', join(here, 'package-lock.json')],
    ['test/fixtures/lifecycle.mjs', resolve(here, '../../../fixtures/lifecycle.mjs')]
]
const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async ([name, path]) => [
    name, createHash('sha256').update(await readFile(path)).digest('hex')
])))
const operationNames = ['singleCreate', 'uuidRead', 'equality', 'nestedEquality', 'numericRange', 'and', 'or',
    'singleKeyUpdate', 'indexedKeyUpdate', 'numericIncrement', 'singleDelete']
const summarizeOperation = (runs, name) => {
    const values = runs.map(run => run.operations?.[name]).filter(Boolean)
    return Object.fromEntries(['firstOperationMs', 'minMs', 'maxMs', 'meanMs', 'p50Ms', 'p95Ms', 'p99Ms', 'opsPerSecond'].map(field => [
        field, median(values.map(value => field === 'firstOperationMs' ? value.firstOperationMs : value.measured?.[field]))
    ]))
}
const summaries = {}
const sections = []
for (const size of [...new Set(manifest.sizes)].sort((a, b) => a - b)) {
    const runs = rawRuns.filter(run => run.datasetSize === size)
    const statuses = manifest.results.filter(run => run.size === size)
    const failures = statuses.filter(run => run.status !== 'passed')
    const operations = Object.fromEntries(operationNames.map(name => [name, summarizeOperation(runs, name)]))
    const sustainedGroups = new Map()
    for (const run of runs) for (const item of run.sustained ?? []) {
        const key = `${item.mode}|${item.concurrency}`
        const group = sustainedGroups.get(key) ?? []
        group.push(item); sustainedGroups.set(key, group)
    }
    const sustained = [...sustainedGroups].map(([key, values]) => {
        const [mode, concurrency] = key.split('|')
        return {
            mode, concurrency: Number(concurrency), opsPerSecond: median(values.map(item => item.opsPerSecond)),
            p50Ms: median(values.map(item => item.latency?.p50Ms)), p95Ms: median(values.map(item => item.latency?.p95Ms)),
            p99Ms: median(values.map(item => item.latency?.p99Ms)), serverCpuPercent: median(values.map(item => item.serverCpuUtilizationPercent)),
            clientCpuPercent: median(values.map(item => item.clientCpuUtilizationPercent)),
            serverRssBytes: median(values.map(item => item.serverMemory?.rssBytes))
        }
    })
    const summary = {
        requestedRuns: manifest.independentRunsRequested, successfulRuns: runs.length,
        failures: failures.map(({ runIndex, status, failure, reason }) => ({ runIndex, status, failure, reason })),
        fixtureHash: runs[0]?.fixtureHash ?? null,
        serverStartupMs: null,
        readinessMs: median(runs.map(run => run.readinessMs)),
        indexSetupMs: median(runs.map(run => run.indexSetupMs)),
        indexReadyMs: median(runs.map(run => run.indexReadyMs)),
        indexCatchupMs: median(runs.map(run => run.indexCatchupMs)),
        firstObjectCreateMs: median(runs.map(run => run.firstObjectCreateMs)),
        createAndIndexMs: median(runs.map(run => run.createAndIndexMs)),
        createRecordsPerSecond: median(runs.map(run => run.createRecordsPerSecond)),
        totalElapsedMs: median(runs.map(run => run.totalElapsedMs)), operations, sustained,
        resources: {
            clientIdleRssBytes: median(runs.map(run => run.clientMemory?.idle?.rss)),
            clientLoadedRssBytes: median(runs.map(run => run.clientMemory?.loaded?.rss)),
            clientFinalRssBytes: median(runs.map(run => run.clientMemory?.final?.rss)),
            clientPeakRssBytes: median(runs.map(run => run.clientMemory?.peakRssBytes)),
            serverIdleRssBytes: median(runs.map(run => run.serverMemory?.idle?.rssBytes)),
            serverLoadedRssBytes: median(runs.map(run => run.serverMemory?.loaded?.rssBytes)),
            serverPeakRssBytes: median(runs.map(run => run.serverMemory?.peakRssBytes))
        }
    }
    summaries[size] = summary
    const operationRows = Object.entries(operations).map(([name, item]) =>
        `| ${name} | ${fmt(item.firstOperationMs)} | ${fmt(item.meanMs)} | ${fmt(item.p50Ms)} | ${fmt(item.p95Ms)} | ${fmt(item.p99Ms)} | ${ops(item.opsPerSecond)} |`)
    const sustainedRows = sustained.map(item =>
        `| ${item.mode} | ${item.concurrency} | ${ops(item.opsPerSecond)} | ${fmt(item.p50Ms)} | ${fmt(item.p95Ms)} | ${fmt(item.p99Ms)} | ${fmt(item.clientCpuPercent)}% | ${fmt(item.serverCpuPercent)}% |`)
    const failureRows = failures.map(run => `| ${run.runIndex ?? '-'} | ${run.status} | ${run.failure?.message ?? run.reason ?? 'see manifest'} |`)
    sections.push([
        `## ${size.toLocaleString()} objects`, '',
        `- Independent runs: ${runs.length}/${manifest.independentRunsRequested} passed. Fixture hash: \`${summary.fixtureHash ?? 'n/a'}\`.`,
        `- Bucket/collection setup is per-run; indexes are established before ingest. GSI online: ${fmt(summary.indexReadyMs)} ms; ingest index catch-up: ${fmt(summary.indexCatchupMs)} ms.`,
        `- First object create: ${fmt(summary.firstObjectCreateMs)} ms; bulk create: ${fmt(summary.createAndIndexMs)} ms (${ops(summary.createRecordsPerSecond)}).`,
        `- Couchbase server RSS (idle / loaded / peak sum across server processes): ${mib(summary.resources.serverIdleRssBytes)} / ${mib(summary.resources.serverLoadedRssBytes)} / ${mib(summary.resources.serverPeakRssBytes)}.`,
        `- Client Node RSS (idle / loaded / peak): ${mib(summary.resources.clientIdleRssBytes)} / ${mib(summary.resources.clientLoadedRssBytes)} / ${mib(summary.resources.clientPeakRssBytes)}.`, '',
        '| Operation | First ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: |', ...operationRows, '',
        '| Sustained mode | In flight | ops/s | p50 ms | p95 ms | p99 ms | Client CPU | Server CPU |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |', ...(sustainedRows.length ? sustainedRows : ['| n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |']), '',
        '| Run | Status | Failure / skip reason |', '| ---: | --- | --- |', ...(failureRows.length ? failureRows : ['| - | all passed | - |'])
    ].join('\n'))
}

const standardized = {
    runId: manifest.runId, date: manifest.startedAt, serverVersion: manifest.serverVersion,
    driverVersion: manifest.driverVersion, fixtureVersion: '3.0.0', benchmarkSourceSha256: sourceHashes, sizes: summaries,
    methodology: manifest.resourcePolicy, failures: manifest.results.filter(run => run.status !== 'passed')
}
const providerPath = join(here, 'results/summary.json')
let provider
try { provider = JSON.parse(await readFile(providerPath, 'utf8')) }
catch { provider = { provider: 'Couchbase Server Community', historical: null, standardized: { runs: [] } } }
provider.standardized ??= { runs: [] }
const duplicate = provider.standardized.runs.findIndex(run => run.runId === standardized.runId)
if (duplicate === -1) provider.standardized.runs.push(standardized)
else provider.standardized.runs[duplicate] = standardized
await writeFile(providerPath, `${JSON.stringify(provider, null, 2)}\n`)
await writeFile(join(directory, 'summary.json'), `${JSON.stringify(standardized, null, 2)}\n`)

const latest = async name => {
    try {
        const data = JSON.parse(await readFile(join(here, `../${name}/results/summary.json`), 'utf8'))
        return data.standardized?.runs?.at(-1) ?? null
    } catch { return null }
}
const priorRuns = Object.fromEntries(await Promise.all(['cocreatedb', 'mongodb', 'redis'].map(async name => [name, await latest(name)])))
const comparisons = []
for (const [size, current] of Object.entries(summaries)) {
    const prior = {}
    for (const [name, run] of Object.entries(priorRuns)) {
        const item = name === 'redis' ? run?.sizes?.['json-search']?.[size] : run?.sizes?.[size]
        if (!item) continue
        prior[name] = {
            runId: run.runId,
            fixtureHashMatches: item.fixtureHash === current.fixtureHash,
            createAndIndexMs: item.createAndIndexMs + (name === 'cocreatedb' ? 0 : item.indexSetupMs ?? 0),
            uuidReadP50Ms: item.operations?.uuidRead?.p50Ms ?? item.operations?.uuidRead?.p50 ?? null,
            equalityP50Ms: item.operations?.equality?.p50Ms ?? item.operations?.equality?.p50 ?? null,
            numericRangeP50Ms: item.operations?.numericRange?.p50Ms ?? item.operations?.numericRange?.p50 ?? null
        }
    }
    comparisons.push({ size: Number(size), couchbase: {
        fixtureHashMatches: true,
        createAndIndexMs: current.createAndIndexMs + current.indexSetupMs,
        uuidReadP50Ms: current.operations.uuidRead.p50Ms,
        equalityP50Ms: current.operations.equality.p50Ms,
        numericRangeP50Ms: current.operations.numericRange.p50Ms
    }, prior })
}
standardized.comparisonsToExistingLanes = comparisons
await writeFile(providerPath, `${JSON.stringify(provider, null, 2)}\n`)
await writeFile(join(directory, 'summary.json'), `${JSON.stringify(standardized, null, 2)}\n`)

const comparisonSection = [
    '## Same-fixture reference comparison', '',
    'These are the latest existing provider snapshots, not simultaneous controlled runs. Fixture SHA-256 must match to be included. Provider versions/configurations and run windows differ. The creation column adds secondary-index setup to bulk ingest for external providers; CoCreateDB measures in-memory index creation as part of its create path.', '',
    '| Size | Provider | Bulk create + index setup ms | UUID read p50 ms | Equality p50 ms | Numeric range p50 ms | Fixture match |',
    '| ---: | --- | ---: | ---: | ---: | ---: | --- |'
]
for (const row of comparisons) {
    for (const [name, item] of Object.entries(row.prior)) {
        const label = name === 'cocreatedb' ? 'CoCreateDB (memory)' : name === 'mongodb' ? 'MongoDB' : 'Redis JSON/Search'
        comparisonSection.push(`| ${row.size.toLocaleString()} | ${label} | ${fmt(item.createAndIndexMs)} | ${fmt(item.uuidReadP50Ms)} | ${fmt(item.equalityP50Ms)} | ${fmt(item.numericRangeP50Ms)} | ${item.fixtureHashMatches ? 'yes' : 'no'} |`)
    }
    comparisonSection.push(`| ${row.size.toLocaleString()} | Couchbase | ${fmt(row.couchbase.createAndIndexMs)} | ${fmt(row.couchbase.uuidReadP50Ms)} | ${fmt(row.couchbase.equalityP50Ms)} | ${fmt(row.couchbase.numericRangeP50Ms)} | yes |`)
}
const orPlan = rawRuns.find(run => run.datasetSize === Math.max(...manifest.sizes))?.queryPlans?.or?.[0]?.plan
const hasExplicitOrSort = JSON.stringify(orPlan ?? {}).includes('"#operator":"Order"')
standardized.observations = [
    `At ${Math.max(...manifest.sizes).toLocaleString()} documents, OR equality p50 was ${fmt(summaries[Math.max(...manifest.sizes)].operations.or.p50Ms)} ms. EXPLAIN ${hasExplicitOrSort ? 'shows an explicit Order operator after the two GSI spans' : 'is available in each raw trial for plan inspection'}.`
]
await writeFile(providerPath, `${JSON.stringify(provider, null, 2)}\n`)
await writeFile(join(directory, 'summary.json'), `${JSON.stringify(standardized, null, 2)}\n`)

const report = [
    '# Couchbase standardized benchmark results', '',
    `- Run ID: \`${manifest.runId}\`; ${manifest.startedAt} to ${manifest.completedAt}.`,
    `- Couchbase Server: ${manifest.serverVersion}; Node SDK: ${manifest.driverVersion}; source revision: \`${rawRuns[0]?.sourceRevision ?? 'unknown'}\`.`,
    `- Benchmark source fingerprint: \`${createHash('sha256').update(JSON.stringify(sourceHashes)).digest('hex')}\`; component file hashes are in \`summary.json\`.`,
    `- Runtime: ${rawRuns[0]?.environment?.node ?? 'unknown'} on ${rawRuns[0]?.environment?.platform ?? 'unknown'}; CPU ${rawRuns[0]?.environment?.cpuModel ?? 'unknown'} (${rawRuns[0]?.environment?.cpuCount ?? '?'} logical CPUs); RAM ${mib(rawRuns[0]?.environment?.totalMemoryBytes)}.`,
    `- Method: ${manifest.independentRunsRequested} independent fresh buckets per size; ${manifest.sampleCount} measured samples and ${manifest.warmupCount} warmups per operation; ${manifest.sustainedDurationMs} ms sustained per mode/concurrency.`,
    `- Process model: ${rawRuns[0]?.environment?.processModel}; persistence: ${rawRuns[0]?.environment?.persistence}; durability: ${rawRuns[0]?.environment?.durability}.`,
    '- Couchbase server was started once outside the timed suite and kept running; each run created and deleted a fresh bucket, with the same local server process and OS cache. Server startup is not included.',
    '- This server is Community Edition with Couchstore and ForestDB GSI indexes. Five workload indexes are created before fixture ingest and maintained during writes. Couchbase KV Get uses the document key equal to fixture `uuid`; query scans are SQL++ over GSI with `RequestPlus` catch-up before read tests and `NotBounded` during timed reads.',
    '- Ingest timings cover SDK KV insert request latency and background index maintenance, not index creation. GSI creation/readiness and post-ingest index catch-up are measured separately. A 512 MiB bucket quota is reserved per run; no replicas, transactions, durability level, or external persistence are enabled.',
    '- Server RSS is the sum of resident sizes across discovered Couchbase processes and can double-count shared pages. CPU tick deltas are process-summed, approximate, and may exceed 100% when multiple cores are busy.', '',
    '| Size | Runs passed | Fixture hash | Index setup ms | GSI ready ms | Index catch-up ms | Bulk create ms | Create ops/s | Server loaded RSS |',
    '| ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...Object.entries(summaries).map(([size, item]) => `| ${Number(size).toLocaleString()} | ${item.successfulRuns}/${item.requestedRuns} | \`${item.fixtureHash ?? 'n/a'}\` | ${fmt(item.indexSetupMs)} | ${fmt(item.indexReadyMs)} | ${fmt(item.indexCatchupMs)} | ${fmt(item.createAndIndexMs)} | ${ops(item.createRecordsPerSecond)} | ${mib(item.resources.serverLoadedRssBytes)} |`), '',
    ...sections, '', ...comparisonSection, '', '## Query-plan observation', '',
    `At ${Math.max(...manifest.sizes).toLocaleString()} documents, OR equality p50 was ${fmt(summaries[Math.max(...manifest.sizes)].operations.or.p50Ms)} ms. EXPLAIN ${hasExplicitOrSort ? 'shows an explicit Order operator after the two GSI spans, likely contributing to the slower OR result.' : 'is stored in the raw trials for follow-up.'}`, '',
    '## Raw results and limits', '',
    `Raw run JSON, manifest and generated summary are in \`${directory}\`. The append-only provider summary is [summary.json](../summary.json). The run compares identical fixture content and result UUID ordering; indexes and persistence semantics differ by provider, as documented above.`,
    'Couchbase Server Community requires a local install with the Data, Query and Index services enabled, a 1 GiB data quota, and ForestDB index storage mode configured before any GSI indexes are created. This lane does not measure cluster startup, multi-node replication, durability acknowledgements, failover or remote network latency.'
].join('\n')
await writeFile(join(directory, 'report.md'), `${report}\n`)
console.log(`report=${join(directory, 'report.md')}`)
console.log(`summary=${providerPath}`)
for (const [size, item] of Object.entries(summaries))
    console.log(`size=${size} passed=${item.successfulRuns}/${item.requestedRuns} create=${fmt(item.createAndIndexMs)}ms uuidReadP50=${fmt(item.operations.uuidRead.p50Ms)}ms equalityP50=${fmt(item.operations.equality.p50Ms)}ms rangeP50=${fmt(item.operations.numericRange.p50Ms)}ms`)
