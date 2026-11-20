import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = resolve(process.argv[2] ?? '')
if (!process.argv[2]) throw Error('Usage: node report.mjs <run-directory>')
const here = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
const readJson = async path => JSON.parse(await readFile(path, 'utf8'))
const median = values => {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
    if (!sorted.length) return null
    const mid = sorted.length >> 1
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
const fmt = value => value === null || value === undefined ? 'n/a' : Number(value).toFixed(3)
const mibs = value => value === null || value === undefined ? 'n/a' : `${(value / 1024 / 1024).toFixed(2)} MiB`
const ops = value => value === null || value === undefined ? 'n/a' : `${Math.round(value).toLocaleString()} ops/s`
const successful = await Promise.all(manifest.results.filter(run => run.status === 'passed').map(run => readJson(join(directory, run.file))))
const bySize = new Map()
for (const run of successful) {
    const values = bySize.get(run.datasetSize) ?? []
    values.push(run)
    bySize.set(run.datasetSize, values)
}
const summarizeOperation = (runs, name) => {
    const values = runs.map(run => run.operations?.[name]).filter(Boolean)
    return Object.fromEntries(['firstOperationMs', 'minMs', 'maxMs', 'meanMs', 'p50Ms', 'p95Ms', 'p99Ms', 'opsPerSecond'].map(field => [
        field, median(values.map(value => field === 'firstOperationMs' ? value.firstOperationMs : value.measured?.[field]).filter(Number.isFinite))
    ]))
}
const operationNames = ['singleCreate', 'uuidRead', 'equality', 'nestedEquality', 'numericRange', 'and', 'or', 'singleKeyUpdate', 'indexedKeyUpdate', 'numericIncrement', 'singleDelete']
const sizes = [...new Set(manifest.sizes)].sort((a, b) => a - b)
const summaries = {}
const sections = []
for (const size of sizes) {
    const runs = bySize.get(size) ?? []
    const failures = manifest.results.filter(run => run.size === size && run.status !== 'passed')
    const operations = Object.fromEntries(operationNames.map(name => [name, summarizeOperation(runs, name)]))
    const queryPlanNames = ['equality', 'nestedEquality', 'numericRange', 'and', 'or']
    const queryPlans = Object.fromEntries(queryPlanNames.map(name => {
        const plans = runs.map(run => run.queryPlans?.[name]).filter(Boolean)
        const indexes = new Set()
        const walk = plan => {
            if (!plan || typeof plan !== 'object') return
            if (plan.indexName) indexes.add(plan.indexName)
            for (const value of Object.values(plan)) {
                if (Array.isArray(value)) value.forEach(walk)
                else if (value && typeof value === 'object') walk(value)
            }
        }
        for (const plan of plans) walk(plan.winningPlan)
        return [name, {
            indexes: [...indexes].sort(),
            nReturned: median(plans.map(plan => plan.nReturned)),
            keysExamined: median(plans.map(plan => plan.totalKeysExamined)),
            docsExamined: median(plans.map(plan => plan.totalDocsExamined))
        }]
    }))
    const sustainedGroups = new Map()
    for (const run of runs) for (const item of run.sustained ?? []) {
        const key = `${item.mode}|${item.concurrency}`
        const values = sustainedGroups.get(key) ?? []
        values.push(item)
        sustainedGroups.set(key, values)
    }
    const sustained = [...sustainedGroups].map(([key, values]) => {
        const [mode, concurrency] = key.split('|')
        return {
            mode, concurrency: Number(concurrency),
            opsPerSecond: median(values.map(value => value.opsPerSecond)),
            p50Ms: median(values.map(value => value.latency?.p50Ms)),
            p95Ms: median(values.map(value => value.latency?.p95Ms)),
            p99Ms: median(values.map(value => value.latency?.p99Ms)),
            clientCpuPercent: median(values.map(value => value.clientCpuUtilizationPercent)),
            serverCpuPercent: median(values.map(value => value.serverCpuUtilizationPercent)),
            serverRssBytes: median(values.map(value => value.serverMemory?.VmRSS))
        }
    })
    const summary = {
        requestedRuns: manifest.independentRunsRequested, successfulRuns: runs.length,
        failures: failures.map(({ runIndex, status, failure, reason }) => ({ runIndex, status, failure, reason })),
        fixtureHash: runs[0]?.fixtureHash ?? null,
        firstObjectCreateMs: median(runs.map(run => run.firstObjectCreateMs)),
        serverStartupMs: median(runs.map(run => run.serverStartupMs)),
        readinessMs: median(runs.map(run => run.readinessMs)),
        indexSetupMs: median(runs.map(run => run.indexSetupMs)),
        createAndIndexMs: median(runs.map(run => run.createAndIndexMs)),
        createRecordsPerSecond: median(runs.map(run => run.createRecordsPerSecond)),
        totalElapsedMs: median(runs.map(run => run.totalElapsedMs)),
        operations, queryPlans, sustained,
        resources: {
            clientIdleRssBytes: median(runs.map(run => run.clientMemory?.idle?.rss)),
            clientLoadedRssBytes: median(runs.map(run => run.clientMemory?.loaded?.rss)),
            clientFinalRssBytes: median(runs.map(run => run.clientMemory?.final?.rss)),
            clientPeakRssBytes: median(runs.map(run => run.clientMemory?.peakRssBytes)),
            serverIdleRssBytes: median(runs.map(run => run.serverMemory?.idle?.VmRSS)),
            serverLoadedRssBytes: median(runs.map(run => run.serverMemory?.loaded?.VmRSS)),
            serverPeakRssBytes: median(runs.map(run => run.serverResourceUsage?.final?.VmHWM)),
            serverDbPathBytes: median(runs.map(run => run.serverMemory?.databasePathBytes)),
            serverCpuMs: median(runs.map(run => run.serverResourceUsage?.cpuMs)),
            clientCpuMs: median(runs.map(run => run.clientCpuUsageUs ? (run.clientCpuUsageUs.user + run.clientCpuUsageUs.system) / 1000 : null)),
            serverCpuUtilizationPercent: median(runs.map(run => run.serverResourceUsage?.cpuUtilizationPercent)),
            clientCpuUtilizationPercent: median(runs.map(run => run.clientCpuUtilizationPercent)),
            storageBytes: median(runs.map(run => run.databaseStats?.storageSize)),
            indexBytes: median(runs.map(run => run.databaseStats?.indexSize)),
            documents: median(runs.map(run => run.databaseStats?.objects)),
            serverIncrementalRssBytesPerFixtureDocument: median(runs.map(run => {
                const idle = run.serverMemory?.idle?.VmRSS
                const loaded = run.serverMemory?.loaded?.VmRSS
                return Number.isFinite(idle) && Number.isFinite(loaded) ? (loaded - idle) / run.datasetSize : null
            })),
            clientIncrementalRssBytesPerFixtureDocument: median(runs.map(run => {
                const idle = run.clientMemory?.idle?.rss
                const loaded = run.clientMemory?.loaded?.rss
                return Number.isFinite(idle) && Number.isFinite(loaded) ? (loaded - idle) / run.datasetSize : null
            }))
        }
    }
    summaries[size] = summary
    const operationRows = operationNames.map(name => {
        const item = operations[name]
        return `| ${name} | ${fmt(item.firstOperationMs)} | ${fmt(item.minMs)} | ${fmt(item.maxMs)} | ${fmt(item.meanMs)} | ${fmt(item.p50Ms)} | ${fmt(item.p95Ms)} | ${fmt(item.p99Ms)} | ${ops(item.opsPerSecond)} |`
    })
    const queryPlanRows = queryPlanNames.map(name => {
        const plan = queryPlans[name]
        return `| ${name} | ${plan.indexes.join(', ') || 'no IXSCAN reported'} | ${fmt(plan.nReturned)} | ${fmt(plan.keysExamined)} | ${fmt(plan.docsExamined)} |`
    })
    const sustainedRows = sustained.map(item => `| ${item.mode} | ${item.concurrency} | ${ops(item.opsPerSecond)} | ${fmt(item.p50Ms)} | ${fmt(item.p95Ms)} | ${fmt(item.p99Ms)} | ${fmt(item.clientCpuPercent)}% | ${fmt(item.serverCpuPercent)}% |`)
    sections.push([
        `## ${size.toLocaleString()} documents`, '',
        `- Independent trials: ${runs.length}/${manifest.independentRunsRequested}; fixture SHA-256: \`${summary.fixtureHash ?? 'n/a'}\`.`,
        `- Mongo startup: ${fmt(summary.serverStartupMs)} ms; driver connect/readiness: ${fmt(summary.readinessMs)} ms; first insert: ${fmt(summary.firstObjectCreateMs)} ms.`,
        `- Explicit index setup on empty collection: ${fmt(summary.indexSetupMs)} ms; insert/index-maintenance: ${fmt(summary.createAndIndexMs)} ms (${ops(summary.createRecordsPerSecond)}).`,
        `- Total trial time: ${fmt(summary.totalElapsedMs)} ms.`,
        `- Documents in DB (includes one seed document): ${fmt(summary.resources.documents)}; data/index storage: ${mibs(summary.resources.storageBytes)} / ${mibs(summary.resources.indexBytes)}; temporary dbPath files: ${mibs(summary.resources.serverDbPathBytes)}.`,
        `- Client idle/loaded/final/peak RSS: ${mibs(summary.resources.clientIdleRssBytes)} / ${mibs(summary.resources.clientLoadedRssBytes)} / ${mibs(summary.resources.clientFinalRssBytes)} / ${mibs(summary.resources.clientPeakRssBytes)}; mongod idle/loaded/peak RSS: ${mibs(summary.resources.serverIdleRssBytes)} / ${mibs(summary.resources.serverLoadedRssBytes)} / ${mibs(summary.resources.serverPeakRssBytes)}.`,
        `- Incremental loaded RSS per fixture document: client ${fmt(summary.resources.clientIncrementalRssBytesPerFixtureDocument)} B, mongod ${fmt(summary.resources.serverIncrementalRssBytesPerFixtureDocument)} B. Client/server CPU: ${fmt(summary.resources.clientCpuMs)} / ${fmt(summary.resources.serverCpuMs)} ms (${fmt(summary.resources.clientCpuUtilizationPercent)}% / ${fmt(summary.resources.serverCpuUtilizationPercent)}%) per trial median. Disk I/O counters were unavailable.`, '',
        '| Operation | First ms | Warm min ms | Warm max ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |', ...operationRows, '',
        '| Query | Winning indexes | Returned | Keys examined | Documents examined |', '| --- | --- | ---: | ---: | ---: |', ...queryPlanRows, '',
        '| Sustained workload | In-flight | ops/s | p50 ms | p95 ms | p99 ms | Client CPU | mongod CPU |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |', ...(sustainedRows.length ? sustainedRows : ['| n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |']), '',
        '| Run | Status | Failure |', '| ---: | --- | --- |', ...(failures.length ? failures.map(run => `| ${run.runIndex ?? '-'} | ${run.status} | ${run.failure?.message ?? run.reason ?? 'see manifest'} |`) : ['| - | all passed | - |'])
    ].join('\n'))
}

const providerPath = resolve(here, '../mongodb.json')
const provider = await readJson(providerPath)
const cdbProvider = await readJson(resolve(here, '../cocreatedb.json'))
const latestCdb = [...(cdbProvider.standardized?.runs ?? [])].sort((a, b) => String(a.date).localeCompare(String(b.date))).at(-1)
const comparisons = []
if (latestCdb) for (const size of sizes) {
    const mongo = summaries[size]
    const cocreate = latestCdb.sizes?.[size]
    if (!cocreate) continue
    comparisons.push({
        size, fixtureHashMatches: mongo.fixtureHash === cocreate.fixtureHash,
        cocreatedbRunId: latestCdb.runId,
        cocreatedbFixtureHash: cocreate.fixtureHash,
        mongoFixtureHash: mongo.fixtureHash,
        cocreatedb: {
            uuidReadP50Ms: cocreate.operations?.uuidRead?.p50,
            equalityP50Ms: cocreate.operations?.equality?.p50,
            nestedEqualityP50Ms: cocreate.operations?.nestedEquality?.p50,
            numericRangeP50Ms: cocreate.operations?.numericRange?.p50,
            andP50Ms: cocreate.operations?.and?.p50,
            orP50Ms: cocreate.operations?.or?.p50,
            singleCreateP50Ms: cocreate.operations?.singleCreate?.p50,
            singleKeyUpdateP50Ms: cocreate.operations?.singleKeyUpdate?.p50,
            numericIncrementP50Ms: cocreate.operations?.numericIncrement?.p50,
            singleDeleteP50Ms: cocreate.operations?.singleDelete?.p50,
            createAndIndexMs: cocreate.createAndIndexMs
        },
        mongodb: {
            uuidReadP50Ms: mongo.operations.uuidRead.p50Ms,
            equalityP50Ms: mongo.operations.equality.p50Ms,
            nestedEqualityP50Ms: mongo.operations.nestedEquality.p50Ms,
            numericRangeP50Ms: mongo.operations.numericRange.p50Ms,
            andP50Ms: mongo.operations.and.p50Ms,
            orP50Ms: mongo.operations.or.p50Ms,
            singleCreateP50Ms: mongo.operations.singleCreate.p50Ms,
            singleKeyUpdateP50Ms: mongo.operations.singleKeyUpdate.p50Ms,
            numericIncrementP50Ms: mongo.operations.numericIncrement.p50Ms,
            singleDeleteP50Ms: mongo.operations.singleDelete.p50Ms,
            createAndIndexMs: mongo.createAndIndexMs + mongo.indexSetupMs
        }
    })
}
const historical = provider.historical ?? null
const standardized = {
    runId: manifest.runId, date: manifest.startedAt,
    serverVersion: manifest.serverVersion, driverVersion: manifest.driverVersion,
    sourceRevision: successful[0]?.sourceRevision ?? null,
    runtime: successful[0]?.environment ?? null,
    fixtureVersion: '3.0.0',
    methodology: 'single standalone mongod, loopback TCP, WiredTiger temporary dbPath, five independent runs, no replication or transactions',
    settings: {
        sampleCount: manifest.sampleCount, warmupCount: manifest.warmupCount,
        sustainedDurationMs: manifest.sustainedDurationMs, concurrencyLevels: manifest.concurrencyLevels,
        writeConcern: { w: 1, j: false }, readPreference: 'primary', readConcern: 'local',
        storageEngine: 'wiredTiger', wiredTigerCacheSizeGB: 1
    },
    sizes: summaries, comparisonsWithLatestCocreatedb: comparisons,
    failures: manifest.results.filter(run => run.status !== 'passed')
}
provider.standardized ??= { methodology: 'MongoDB provider benchmark results; historical values remain separate', runs: [] }
const existingIndex = provider.standardized.runs.findIndex(run => run.runId === standardized.runId)
if (existingIndex === -1) provider.standardized.runs.push(standardized)
else provider.standardized.runs[existingIndex] = standardized
await writeFile(providerPath, `${JSON.stringify(provider, null, 2)}\n`)

const first = successful[0]
const historyRows = historical ? [
    `| UUID read | ${fmt(historical.readUuid)} | ${fmt(summaries[1000]?.operations.uuidRead.p50Ms)} |`,
    `| Equality read | ${fmt(historical.readEquality)} | ${fmt(summaries[1000]?.operations.equality.p50Ms)} |`,
    `| Numeric range read | ${fmt(historical.readRange)} | ${fmt(summaries[1000]?.operations.numericRange.p50Ms)} |`,
    `| Create | ${fmt(historical.create)} | ${fmt(summaries[1000]?.operations.singleCreate.p50Ms)} |`,
    `| UUID update | ${fmt(historical.updateUuid)} | ${fmt(summaries[1000]?.operations.singleKeyUpdate.p50Ms)} |`
] : ['| n/a | historical run unavailable | n/a |']
const comparisonSections = comparisons.map(item => {
    const rows = [
        ['UUID read p50', item.cocreatedb.uuidReadP50Ms, item.mongodb.uuidReadP50Ms],
        ['Equality p50', item.cocreatedb.equalityP50Ms, item.mongodb.equalityP50Ms],
        ['Nested equality p50', item.cocreatedb.nestedEqualityP50Ms, item.mongodb.nestedEqualityP50Ms],
        ['Range p50', item.cocreatedb.numericRangeP50Ms, item.mongodb.numericRangeP50Ms],
        ['AND p50', item.cocreatedb.andP50Ms, item.mongodb.andP50Ms],
        ['OR p50', item.cocreatedb.orP50Ms, item.mongodb.orP50Ms],
        ['Create plus index setup ms', item.cocreatedb.createAndIndexMs, item.mongodb.createAndIndexMs],
        ['Single update p50', item.cocreatedb.singleKeyUpdateP50Ms, item.mongodb.singleKeyUpdateP50Ms],
        ['Increment p50', item.cocreatedb.numericIncrementP50Ms, item.mongodb.numericIncrementP50Ms],
        ['Delete p50', item.cocreatedb.singleDeleteP50Ms, item.mongodb.singleDeleteP50Ms]
    ]
    return [`### ${item.size.toLocaleString()} documents`, '', `Fixture hash matches: **${item.fixtureHashMatches}**; CoCreateDB source: \`${item.cocreatedbRunId}\`.`, '', '| Metric | CoCreateDB p50 / total | MongoDB p50 / total |', '| --- | ---: | ---: |', ...rows.map(([label, left, right]) => `| ${label} | ${fmt(left)} | ${fmt(right)} |`)].join('\n')
})
const lines = [
    '# MongoDB benchmark results', '',
    `- Run: \`${manifest.runId}\`; ${manifest.startedAt} to ${manifest.completedAt}.`,
    `- MongoDB: ${manifest.serverVersion}; Node driver: ${manifest.driverVersion}; source revision: \`${first?.sourceRevision ?? 'unavailable'}\`.`,
    `- Runtime: ${first?.environment?.node ?? 'n/a'} on ${first?.environment?.platform ?? 'n/a'}; CPU ${first?.environment?.cpuModel ?? 'n/a'} (${first?.environment?.cpuCount ?? 'n/a'} logical CPUs); RAM ${mibs(first?.environment?.totalMemoryBytes)}; detected process memory limit ${mibs(first?.environment?.memoryLimitBytes)}.`,
    `- MongoDB binary predownload/setup took ${fmt(manifest.binaryPreparationMs)} ms, excluded from server startup and query measurements.`,
    `- Workload policy: ${manifest.independentRunsRequested} independent runs/size; ${manifest.warmupCount} warmups and ${manifest.sampleCount} samples per operation; ${manifest.sustainedDurationMs} ms per sustained mode/concurrency; concurrency ${manifest.concurrencyLevels.join(', ')}.`,
    '- The same programmatic lifecycle v3 fixture and canonical JSON hash used by CoCreateDB are used here. Input creation and fixture hashing are excluded from measured insert/index time.',
    '- Queries and updates are checked against fixture-derived UUIDs/counts before timings are accepted. Read queries return at most 100 results and sort by UUID (numeric range sorts by rank).',
    '- MongoDB uses explicit indexes over the fixture paths and compound keys needed to preserve the ordered query semantics; `_id_` is MongoDB’s built-in identity index. CoCreateDB automatically indexes artifact paths. The report records MongoDB’s complete index list and each winning query plan so query coverage can be audited.',
    '- This is a standalone `mongod` child process with a 1 GiB WiredTiger cache and temporary local WiredTiger files, accessed by the Node driver over loopback TCP. Write acknowledgement is `w:1,j:false`, read preference `primary`, read concern `local`; there is no replica set or transaction workload. This differs from CoCreateDB’s in-process memory-only setup and must not be described as the same durability or transport guarantee.',
    '- Client process and `mongod` CPU/RSS are recorded separately, including loaded-minus-idle RSS per fixture document. This first captured run includes client idle/loaded/final RSS but predates client peak-RSS instrumentation; client peak is therefore reported as unavailable. `mongod` peak is read from its process high-water RSS. Disk usage is reported; OS disk I/O counters were unavailable. Temporary files are deleted after each run. No production dependencies are changed.', '',
    '| Size | Runs | Fixture hash | Index setup ms | Create/index ms | Documents stored | Data + indexes | mongod loaded RSS |', '| ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |',
    ...sizes.map(size => {
        const item = summaries[size]
        return `| ${Number(size).toLocaleString()} | ${item.successfulRuns}/${item.requestedRuns} | \`${item.fixtureHash ?? 'n/a'}\` | ${fmt(item.indexSetupMs)} | ${fmt(item.createAndIndexMs)} | ${fmt(item.resources.documents)} | ${mibs(item.resources.storageBytes)} + ${mibs(item.resources.indexBytes)} | ${mibs(item.resources.serverLoadedRssBytes)} |`
    }), '', ...sections, '',
    '## CoCreateDB comparison', '',
    `Compared with latest standardized CoCreateDB provider summary \`${latestCdb?.runId ?? 'unavailable'}\`. Fixture hashes are checked per size. These are same-fixture results, but not a direct like-for-like ranking: CoCreateDB is in-process and memory-only, while MongoDB uses loopback TCP and WiredTiger files with a 1 GiB cache. Different acknowledgment, persistence and transport costs are retained in the interpretation.`, '',
    ...(comparisonSections.length ? comparisonSections.flatMap(section => [section, '']) : ['No matching CoCreateDB size/hash summary was available.', '']),
    '## Historical MongoDB project numbers', '',
    historical ? `The existing historical summary is from ${historical.date}, ${historical.records} records, ${historical.samples} samples reported as a mean, and lacks raw provider outputs and a fixture hash. Keep it distinct from the new p50 measurements; it is not a controlled comparison.` : 'No historical provider summary is available.', '',
    '| Historical metric | Historical mean ms | New 1K warm p50 ms |', '| --- | ---: | ---: |', ...historyRows, '',
    '## Raw results and failures', '',
    `Raw runs and manifest: \`${directory}\`. Counts: \`${JSON.stringify(manifest.summary)}\`. Provider summary appended to [mongodb.json](../../providers/mongodb.json), retaining historical values.`, '',
    '## Reproduce', '',
    '```sh', 'npm ci --prefix test/benchmarks/providers/mongodb', 'npm run benchmark --prefix test/benchmarks/providers/mongodb', '```', '',
    'The runner defaults to 1,000, 10,000 and 100,000 documents. Override sizes or run policy with positional sizes, `BENCH_RUNS`, `BENCH_SAMPLES`, `BENCH_WARMUPS`, `BENCH_SUSTAIN_MS`, `BENCH_CONCURRENCY` and `BENCH_OUTPUT_DIR`. MongoDB server 9.0.8 is pinned in the adapter; MongoDB binary downloads are cached outside the repository. This adapter is for the initial single-node baseline only; replication and durability comparisons are future work.'
]
await writeFile(join(directory, 'report.md'), `${lines.join('\n')}\n`)
console.log(`report=${join(directory, 'report.md')}`)
console.log(`providerSummary=${providerPath}`)
