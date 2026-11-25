import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = resolve(process.argv[2] ?? '')
if (!process.argv[2]) throw Error('Usage: node test/benchmarks/standard-report.mjs <run-directory>')
const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
const json = async file => JSON.parse(await readFile(join(directory, file), 'utf8'))
const median = values => {
    const sorted = [...values].sort((a, b) => a - b)
    if (!sorted.length) return null
    const mid = sorted.length >> 1
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
const fmt = value => value === null || value === undefined ? 'n/a' : Number(value).toFixed(3)
const miB = value => value === null || value === undefined ? 'n/a' : `${(value / 1024 / 1024).toFixed(2)} MiB`
const ops = value => value === null || value === undefined ? 'n/a' : `${Math.round(value).toLocaleString()} ops/s`
const ok = manifest.results.filter(run => run.status === 'passed')
const rawRuns = await Promise.all(ok.map(run => json(run.file)))
const bySize = new Map()
for (const run of rawRuns) {
    const group = bySize.get(run.datasetSize) ?? []
    group.push(run)
    bySize.set(run.datasetSize, group)
}
function opSummary(runs, key) {
    const entries = runs.map(run => run.operations?.[key]).filter(Boolean)
    return {
        first: median(entries.map(entry => entry.firstOperationMs).filter(Number.isFinite)),
        min: median(entries.map(entry => entry.measured?.minMs).filter(Number.isFinite)),
        max: median(entries.map(entry => entry.measured?.maxMs).filter(Number.isFinite)),
        mean: median(entries.map(entry => entry.measured?.meanMs).filter(Number.isFinite)),
        p50: median(entries.map(entry => entry.measured?.p50Ms).filter(Number.isFinite)),
        p95: median(entries.map(entry => entry.measured?.p95Ms).filter(Number.isFinite)),
        p99: median(entries.map(entry => entry.measured?.p99Ms).filter(Number.isFinite)),
        ops: median(entries.map(entry => entry.measured?.opsPerSecond).filter(Number.isFinite))
    }
}
const sizes = [...new Set(manifest.results.map(run => run.size).filter(Number.isFinite))].sort((a, b) => a - b)
const summaries = {}
const sections = []
for (const size of sizes) {
    const runs = bySize.get(size) ?? []
    const statuses = manifest.results.filter(run => run.size === size)
    const failures = statuses.filter(run => run.status !== 'passed')
    const summary = {
        requestedRuns: manifest.independentRunsRequested,
        successfulRuns: runs.length,
        failedOrSkipped: failures.map(run => ({ runIndex: run.runIndex, status: run.status, failure: run.failure, reason: run.reason })),
        fixtureVersion: runs[0]?.fixtureVersion ?? '3.0.0',
        fixtureHash: runs[0]?.fixtureHash ?? null,
        initializationMs: median(runs.map(run => run.initializationMs)),
        readinessMs: median(runs.map(run => run.readiness?.readyMs)),
        firstObjectCreateMs: median(runs.map(run => run.firstObjectCreateMs)),
        createAndIndexMs: median(runs.map(run => run.createAndIndexMs)),
        createAcknowledgementMs: median(runs.map(run => run.createAcknowledgementMs)),
        fixtureGenerationMs: median(runs.map(run => run.fixtureGenerationMs)),
        indexDrainWaitMs: median(runs.map(run => run.indexDrainWaitMs)),
        createRecordsPerSecond: median(runs.map(run => run.createRecordsPerSecond)),
        totalElapsedMs: median(runs.map(run => run.totalElapsedMs)),
        operations: Object.fromEntries(['singleCreate', 'uuidRead', 'equality', 'nestedEquality', 'numericRange', 'and', 'or', 'singleKeyUpdate', 'indexedKeyUpdate', 'numericIncrement', 'singleDelete'].map(key => [key, opSummary(runs, key)])),
        filteredBulkDeleteMs: median(runs.map(run => run.operations?.filteredBulkDelete?.elapsedMs)),
        filteredBulkDeleteCount: median(runs.map(run => run.operations?.filteredBulkDelete?.deleted)),
        memory: {
            idleRssBytes: median(runs.map(run => run.memory?.idle?.rss)),
            loadedRssBytes: median(runs.map(run => run.memory?.loaded?.rss)),
            peakRssBytes: median(runs.map(run => run.memory?.peakRssBytes)),
            incrementalRssBytes: median(runs.map(run => run.memory?.incrementalRssBytes)),
            incrementalHeapBytes: median(runs.map(run => run.memory?.incrementalHeapBytes)),
            rssBytesPerObject: median(runs.map(run => run.memory?.rssBytesPerObject))
        },
        memoryPolicy: {
            requestedBudgetBytes: median(runs.map(run => run.memoryPolicy?.requestedBudgetBytes)),
            effectiveBudgetBytes: median(runs.map(run => run.memoryPolicy?.effectiveBudgetBytes))
        },
        cpu: {
            userUs: median(runs.map(run => run.cpuUsageUs?.user)),
            systemUs: median(runs.map(run => run.cpuUsageUs?.system)),
            utilizationPercent: median(runs.map(run => run.cpuUtilizationPercent))
        },
        sustained: []
    }
    const sustainedKeys = new Map()
    for (const run of runs) for (const result of run.sustained ?? []) {
        const key = `${result.mode}|${result.concurrency}`
        const values = sustainedKeys.get(key) ?? []
        values.push(result)
        sustainedKeys.set(key, values)
    }
    for (const [key, values] of sustainedKeys) {
        const [mode, concurrency] = key.split('|')
        summary.sustained.push({
            mode, concurrency: Number(concurrency),
            operationsPerSecond: median(values.map(value => value.opsPerSecond)),
            p50Ms: median(values.map(value => value.latency?.p50Ms)),
            p95Ms: median(values.map(value => value.latency?.p95Ms)),
            p99Ms: median(values.map(value => value.latency?.p99Ms)),
            cpuUtilizationPercent: median(values.map(value => value.cpuUtilizationPercent))
        })
    }
    summaries[size] = summary
    const operationRows = Object.entries(summary.operations).map(([name, value]) =>
        `| ${name} | ${fmt(value.first)} | ${fmt(value.min)} | ${fmt(value.max)} | ${fmt(value.mean)} | ${fmt(value.p50)} | ${fmt(value.p95)} | ${fmt(value.p99)} | ${ops(value.ops)} |`)
    const sustainedRows = summary.sustained.map(value =>
        `| ${value.mode} | ${value.concurrency} | ${ops(value.operationsPerSecond)} | ${fmt(value.p50Ms)} | ${fmt(value.p95Ms)} | ${fmt(value.p99Ms)} | ${fmt(value.cpuUtilizationPercent)}% |`)
    const statusRows = failures.map(run => `| ${run.runIndex ?? '-'} | ${run.status} | ${run.failure?.message ?? run.reason ?? 'see manifest'} |`)
    sections.push([
        `## ${size.toLocaleString()} objects`, '',
        `- Runs: ${runs.length}/${manifest.independentRunsRequested} passed; fixture hash: \`${summary.fixtureHash ?? 'none'}\`.`,
        `- Init: ${fmt(summary.initializationMs)} ms; readiness: ${fmt(summary.readinessMs)} ms; first object create: ${fmt(summary.firstObjectCreateMs)} ms.`,
        `- Bulk create/index lifecycle: ${fmt(summary.createAndIndexMs)} ms; ${ops(summary.createRecordsPerSecond)}.`,
        `- Cumulative create acknowledgement wait: ${fmt(summary.createAcknowledgementMs)} ms; fixture generation: ${fmt(summary.fixtureGenerationMs)} ms; final index drain wait: ${fmt(summary.indexDrainWaitMs)} ms.`,
        `- Filtered bulk delete: ${fmt(summary.filteredBulkDeleteMs)} ms for ${summary.filteredBulkDeleteCount ?? 0} leaves.`,
        `- Total independent run time: ${fmt(summary.totalElapsedMs)} ms.`,
        `- Index entries/object: ${runs[0]?.indexEntriesPerObject ?? 'n/a'}; create acknowledgement returns before leaf/index finalization, which is drained before query measurements.`,
        `- Memory (idle / loaded / peak RSS): ${miB(summary.memory.idleRssBytes)} / ${miB(summary.memory.loadedRssBytes)} / ${miB(summary.memory.peakRssBytes)}.`,
        `- Memory allocation: ${manifest.configuration?.memoryPercent ?? runs[0]?.configuration?.memoryPercent ?? 'unknown'}% of system memory; requested / effective budget: ${miB(summary.memoryPolicy.requestedBudgetBytes)} / ${miB(summary.memoryPolicy.effectiveBudgetBytes)}.`,
        `- Incremental memory/object: ${fmt(summary.memory.rssBytesPerObject)} bytes RSS; incremental heap: ${miB(summary.memory.incrementalHeapBytes)}.`,
        `- CPU: ${fmt(summary.cpu.userUs / 1000)} ms user + ${fmt(summary.cpu.systemUs / 1000)} ms system; ${fmt(summary.cpu.utilizationPercent)}% utilization.`, '',
        '| Operation | First ms | Warm min ms | Warm max ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |', ...operationRows, '',
        '| Sustained mode | In-flight | ops/s | p50 ms | p95 ms | p99 ms | CPU utilization |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: |', ...(sustainedRows.length ? sustainedRows : ['| n/a | n/a | n/a | n/a | n/a | n/a | n/a |']), '',
        '| Run | Status | Failure / skip reason |', '| ---: | --- | --- |', ...(statusRows.length ? statusRows : ['| - | all passed | - |'])
    ].join('\n'))
}

const benchmarkRoot = dirname(fileURLToPath(import.meta.url))
const providerFile = join(benchmarkRoot, 'providers/cocreatedb/results/summary.json')
const providerPath = resolve(providerFile)
const provider = JSON.parse(await readFile(providerPath, 'utf8'))
const legacyFiles = manifest.legacyCompatibility?.runs?.filter(run => run.status === 'passed' && run.file) ?? []
const legacyRaw = await Promise.all(legacyFiles.map(run => json(run.file)))
const legacy1000 = legacyRaw.flatMap(run => run.sizes ?? []).filter(run => run.size === 1000)
const historical = provider.scenarios?.fresh
const historicalV2 = historical ? {
    date: provider.date,
    fixtureHash: provider.fixtureHash,
    runtime: { node: provider.node, cpus: provider.cpus },
    samples: provider.samples,
    createAndIndexMs: historical.createAndIndexMs,
    uuidReadP50Ms: historical.readUuid?.p50Ms,
    equalityP50Ms: historical.readEquality?.p50Ms,
    nestedP50Ms: historical.readNestedPath?.p50Ms,
    rangeP50Ms: historical.readRange?.p50Ms,
    updateP50Ms: historical.updateUuid?.p50Ms,
    heapUsedBytes: historical.heapUsedBytes,
    rssBytes: historical.rssBytes
} : null
const compatibility = legacy1000.length ? {
    runs: legacy1000.length,
    fixtureHash: legacy1000[0].fixtureHash,
    runtime: { node: legacyRaw[0].node, platform: legacyRaw[0].platform, cpuCount: legacyRaw[0].cpuCount },
    samples: legacyRaw[0].samples,
    createAndIndexMs: median(legacy1000.map(run => run.createAndIndexMs)),
    uuidReadP50Ms: median(legacy1000.map(run => run.readUuid.p50Ms)),
    equalityP50Ms: median(legacy1000.map(run => run.readEquality.p50Ms)),
    nestedP50Ms: median(legacy1000.map(run => run.readNestedPath.p50Ms)),
    rangeP50Ms: median(legacy1000.map(run => run.readRange.p50Ms)),
    updateP50Ms: median(legacy1000.map(run => run.updateUuid.p50Ms)),
    heapUsedBytes: median(legacy1000.map(run => run.memory.heapUsed)),
    rssBytes: median(legacy1000.map(run => run.memory.rss))
} : null
const summaryEntry = {
    runId: manifest.runId,
    date: manifest.startedAt,
    sourceRevision: rawRuns[0]?.environment?.sourceRevision ?? null,
    runtime: rawRuns[0]?.environment ?? null,
    fixtureVersion: '3.0.0',
    sizes: summaries,
    legacyV2Compatibility: compatibility,
    failures: manifest.results.filter(run => run.status !== 'passed')
}
provider.standardized ??= { methodology: 'CoCreateDB-only phase; in-process, memory-resident, no persistence or network', runs: [] }
const existingSummaryIndex = provider.standardized.runs.findIndex(run => run.runId === summaryEntry.runId)
if (existingSummaryIndex === -1) provider.standardized.runs.push(summaryEntry)
else provider.standardized.runs[existingSummaryIndex] = summaryEntry
await writeFile(providerPath, `${JSON.stringify(provider, null, 2)}\n`)

const lines = [
    '# CoCreateDB standardized benchmark results', '',
    `- Run ID: \`${manifest.runId}\`; executed: ${manifest.startedAt} to ${manifest.completedAt}.`,
    `- Source revision: \`${summaryEntry.sourceRevision ?? 'unavailable'}\`; DB version ${summaryEntry.runtime?.databaseVersion ?? 'unknown'}.`,
    `- Runtime: ${summaryEntry.runtime?.node ?? 'unknown'} / ${summaryEntry.runtime?.platform ?? 'unknown'}; CPU: ${summaryEntry.runtime?.cpuModel ?? 'unknown'} (${summaryEntry.runtime?.cpuCount ?? '?'} logical CPUs); RAM: ${miB(summaryEntry.runtime?.totalMemoryBytes)}; limit: ${miB(summaryEntry.runtime?.memoryLimitBytes)}.`,
    `- Method: ${manifest.independentRunsRequested} independent runs/size; ${manifest.warmupCount} warmups and ${manifest.sampleCount} samples per latency operation; ${manifest.sustainedDurationMs} ms sustained runs per workload/concurrency.`,
    `- Process model: ${summaryEntry.runtime?.processModel}; mode: ${manifest.configuration?.mode ?? 'adaptive'}; acknowledgement: ${manifest.configuration?.acknowledgement ?? 'memory'}; memory allocation: ${manifest.configuration?.memoryPercent ?? 'unknown'}%. ${summaryEntry.runtime?.durability}.`,
    '- No competitor databases, containers, dependencies or datasets were installed or launched.', '',
    'Each run is a fresh child process and database. Fixture data is generated and hashed in 1,000-record batches. The create/index lifecycle timer spans batch generation, create acknowledgements, and the final index drain; fixture generation time and cumulative time awaiting create acknowledgements are reported separately, and background work can overlap those intervals. The fixture hash is over the canonical pre-ingestion JSON dataset. Correctness checks compare UUID result sets before query timings are accepted. Measured request latency stops before result assertions. Sustained modes are read-only, increment-only writes, or alternating read/write calls; concurrency means outstanding in-process requests, not parallel database threads.', '',
    'Initialization and readiness are reported separately. Object create acknowledges before leaf finalization and index attachment; the standard runner drains this background work before beginning query measurements. The full create/index lifecycle includes the final drain. Local Warm writes are queued after memory acknowledgement; their disk drain is not included in request timings. External persistence is not configured. CPU and RSS include both the benchmark client and database in the same Node process. Incremental memory/object is an approximate loaded-minus-idle RSS ratio.', '',
    '| Size | Runs passed | Fixture hash | Create + index ms | Create ops/s | Loaded RSS | Peak RSS |', '| ---: | ---: | --- | ---: | ---: | ---: | ---: |',
    ...sizes.map(size => {
        const item = summaries[size]
        return `| ${Number(size).toLocaleString()} | ${item.successfulRuns}/${item.requestedRuns} | \`${item.fixtureHash ?? 'n/a'}\` | ${fmt(item.createAndIndexMs)} | ${ops(item.createRecordsPerSecond)} | ${miB(item.memory.loadedRssBytes)} | ${miB(item.memory.peakRssBytes)} |`
    }), '', ...sections, '',
    '## Historical v2 lifecycle comparison', '',
    historicalV2 && compatibility
        ? `The retained historical baseline and the current compatibility lane both use fixture v2 hash \`${historicalV2.fixtureHash}\` / \`${compatibility.fixtureHash}\`. Historical: ${historicalV2.runtime.node}, ${historicalV2.runtime.cpus} CPUs, ${historicalV2.samples} samples, ${historicalV2.runs ?? 5} independent runs. Current compatibility: ${compatibility.runtime.node}, ${compatibility.runtime.cpuCount} reported CPUs, ${compatibility.samples} samples, ${compatibility.runs} independent runs. The datasets and lifecycle query/update operations are equivalent, but runtime and hardware metadata differ, so this is a historical comparison rather than a controlled same-host comparison.`
        : 'No v2 compatibility runs completed; historical results remain preserved in `providers/cocreatedb/results/summary.json` and `baselines/2026-11-19-final`.',
    '',
    '| v2 metric | Historical summary | Current compatibility median |', '| --- | ---: | ---: |',
    ...(historicalV2 && compatibility ? [
        `| Create + index ms | ${fmt(historicalV2.createAndIndexMs)} | ${fmt(compatibility.createAndIndexMs)} |`,
        `| UUID read p50 ms | ${fmt(historicalV2.uuidReadP50Ms)} | ${fmt(compatibility.uuidReadP50Ms)} |`,
        `| Equality p50 ms | ${fmt(historicalV2.equalityP50Ms)} | ${fmt(compatibility.equalityP50Ms)} |`,
        `| Nested equality p50 ms | ${fmt(historicalV2.nestedP50Ms)} | ${fmt(compatibility.nestedP50Ms)} |`,
        `| Range p50 ms | ${fmt(historicalV2.rangeP50Ms)} | ${fmt(compatibility.rangeP50Ms)} |`,
        `| Update p50 ms | ${fmt(historicalV2.updateP50Ms)} | ${fmt(compatibility.updateP50Ms)} |`,
        `| Heap used | ${miB(historicalV2.heapUsedBytes)} | ${miB(compatibility.heapUsedBytes)} |`,
        `| RSS | ${miB(historicalV2.rssBytes)} | ${miB(compatibility.rssBytes)} |`
    ] : ['| n/a | retained only in the historical provider summary | n/a |']), '',
    '## Raw results and failures', '',
    `Raw independent runs and the manifest are stored under \`${directory}\`. Status counts: ${JSON.stringify(manifest.summary)}. Provider summary appended to [summary.json](../summary.json) without replacing historical data.`,
    '',
    '## Limits and follow-up', '',
    'This report measures a single-node CoCreateDB run with adaptive memory residency and local Warm writes. MongoDB and Redis have separate provider adapters and reports; compare their results by operation while accounting for transport, indexing and durability differences. Distributed synchronization, replication, sharding, external persistence durability, server/client separation, and transaction guarantees are out of scope.'
]
await writeFile(join(directory, 'report.md'), `${lines.join('\n')}\n`)
console.log(`report=${join(directory, 'report.md')}`)
console.log(`providerSummary=${providerPath}`)
