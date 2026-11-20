import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = resolve(process.argv[2] ?? '')
if (!process.argv[2]) throw Error('Usage: node report.mjs <run-directory>')
const here = dirname(fileURLToPath(import.meta.url))
const readJson = async path => JSON.parse(await readFile(path, 'utf8'))
const median = values => {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
    if (!sorted.length) return null
    const mid = sorted.length >> 1
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
const fmt = value => value === null || value === undefined ? 'n/a' : Number(value).toFixed(3)
const mibs = value => value === null || value === undefined ? 'n/a' : `${(value / 1048576).toFixed(2)} MiB`
const ops = value => value === null || value === undefined ? 'n/a' : `${Math.round(value).toLocaleString()} ops/s`
const manifest = await readJson(join(directory, 'manifest.json'))
const runs = await Promise.all(manifest.results.filter(item => item.status === 'passed').map(item => readJson(join(directory, item.file))))
const failed = manifest.results.filter(item => item.status !== 'passed')
const opNames = ['uuidRead', 'equality', 'nestedEquality', 'numericRange', 'and', 'or', 'singleCreate', 'singleKeyUpdate', 'numericIncrement', 'singleDelete']
const summaries = {}
const sections = []
for (const mode of manifest.modes) {
    summaries[mode] = {}
    for (const size of manifest.sizes) {
        const group = runs.filter(run => run.mode === mode && run.datasetSize === size)
        const opSummary = Object.fromEntries(opNames.map(name => {
            const entries = group.map(run => run.operations?.[name]).filter(Boolean)
            return [name, Object.fromEntries(['firstOperationMs', 'minMs', 'maxMs', 'meanMs', 'p50Ms', 'p95Ms', 'p99Ms', 'opsPerSecond'].map(field => [field,
                median(entries.map(entry => field === 'firstOperationMs' ? entry.firstOperationMs : entry.measured?.[field]).filter(Number.isFinite))]))]
        }))
        const sustainedGroups = new Map()
        for (const run of group) for (const item of run.sustained ?? []) {
            const key = `${item.mode}|${item.concurrency}`
            const values = sustainedGroups.get(key) ?? []; values.push(item); sustainedGroups.set(key, values)
        }
        const sustained = [...sustainedGroups].map(([key, values]) => {
            const [type, concurrency] = key.split('|')
            return { type, concurrency: Number(concurrency), opsPerSecond: median(values.map(value => value.opsPerSecond)),
                p50Ms: median(values.map(value => value.latency?.p50Ms)), p95Ms: median(values.map(value => value.latency?.p95Ms)),
                p99Ms: median(values.map(value => value.latency?.p99Ms)), clientCpuPercent: median(values.map(value => value.clientCpuUtilizationPercent)),
                serverCpuPercent: median(values.map(value => value.serverCpuUtilizationPercent)),
                serverRssBytes: median(values.map(value => value.serverMemory?.VmRSS)) }
        })
        const summary = {
            requestedRuns: manifest.independentRunsRequested, successfulRuns: group.length,
            fixtureHash: group[0]?.fixtureHash ?? null,
            firstObjectCreateMs: median(group.map(run => run.firstObjectCreateMs)),
            serverStartupMs: median(group.map(run => run.serverStartupMs)),
            indexSetupMs: median(group.map(run => run.indexSetupMs)),
            createAndIndexMs: median(group.map(run => run.createAndIndexMs)),
            createRecordsPerSecond: median(group.map(run => run.createRecordsPerSecond)),
            redisMemoryBytes: median(group.map(run => Number(run.redisMemory?.match(/used_memory:(\d+)/)?.[1]))),
            serverIdleRssBytes: median(group.map(run => run.serverMemory?.idle?.VmRSS)),
            serverLoadedRssBytes: median(group.map(run => run.serverMemory?.loaded?.VmRSS)),
            serverPeakRssBytes: median(group.map(run => run.serverMemory?.peakRssBytes)),
            clientIdleRssBytes: median(group.map(run => run.clientMemory?.idle?.rss)),
            clientLoadedRssBytes: median(group.map(run => run.clientMemory?.loaded?.rss)),
            clientPeakRssBytes: median(group.map(run => run.clientMemory?.peakRssBytes)),
            serverCpuMs: median(group.map(run => run.serverResourceUsage?.cpuMs)),
            clientCpuMs: median(group.map(run => run.clientCpuUsageUs ? (run.clientCpuUsageUs.user + run.clientCpuUsageUs.system) / 1000 : null)),
            operations: opSummary, sustained
        }
        summaries[mode][size] = summary
        const rows = opNames.map(name => {
            const item = opSummary[name]
            return `| ${name} | ${fmt(item.firstOperationMs)} | ${fmt(item.meanMs)} | ${fmt(item.p50Ms)} | ${fmt(item.p95Ms)} | ${fmt(item.p99Ms)} | ${ops(item.opsPerSecond)} |`
        })
        const sustainedRows = sustained.map(item => `| ${item.type} | ${item.concurrency} | ${ops(item.opsPerSecond)} | ${fmt(item.p50Ms)} | ${fmt(item.p95Ms)} | ${fmt(item.p99Ms)} | ${fmt(item.clientCpuPercent)}% | ${fmt(item.serverCpuPercent)}% |`)
        sections.push([
            `## ${mode}: ${Number(size).toLocaleString()} documents`, '',
            `- Trials: ${group.length}/${manifest.independentRunsRequested}; fixture SHA-256: \`${summary.fixtureHash ?? 'n/a'}\`.`,
            `- Redis startup: ${fmt(summary.serverStartupMs)} ms; first ${mode === 'string' ? 'SET' : 'JSON.SET'}: ${fmt(summary.firstObjectCreateMs)} ms; index setup: ${fmt(summary.indexSetupMs)} ms.`,
            `- Fixture load and index maintenance: ${fmt(summary.createAndIndexMs)} ms (${ops(summary.createRecordsPerSecond)}); Redis used memory: ${mibs(summary.redisMemoryBytes)}; server idle/loaded/peak RSS: ${mibs(summary.serverIdleRssBytes)} / ${mibs(summary.serverLoadedRssBytes)} / ${mibs(summary.serverPeakRssBytes)}; Node idle/loaded/peak RSS: ${mibs(summary.clientIdleRssBytes)} / ${mibs(summary.clientLoadedRssBytes)} / ${mibs(summary.clientPeakRssBytes)}.`,
            `- Median CPU per trial: Node ${fmt(summary.clientCpuMs)} ms, Redis ${fmt(summary.serverCpuMs)} ms.`,
            mode === 'string' ? '- This lane measures JSON text through Redis String SET/GET; equality, range and secondary-index queries do not apply.' : '- This lane measures RedisJSON, RediSearch JSON path indexes, equality, nested equality, numeric range, AND/OR selection and filtered deletion.', '',
            '| Operation | First ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: |', ...rows, '',
            '| Sustained workload | In-flight | ops/s | p50 ms | p95 ms | p99 ms | Client CPU | Redis CPU |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |', ...(sustainedRows.length ? sustainedRows : ['| n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |'])
        ].join('\n'))
    }
}
const providerPath = resolve(here, '../redis.json')
const provider = await readJson(providerPath)
const standardPath = resolve(here, '../cocreatedb.json')
const cdb = await readJson(standardPath)
const latestCdb = [...(cdb.standardized?.runs ?? [])].sort((a, b) => String(a.date).localeCompare(String(b.date))).at(-1)
const comparisons = Object.fromEntries(manifest.modes.map(mode => [mode, Object.fromEntries(manifest.sizes.map(size => {
    const redis = summaries[mode][size], local = latestCdb?.sizes?.[size]
    return [size, { fixtureHashMatches: Boolean(redis.fixtureHash && redis.fixtureHash === local?.fixtureHash),
        cocreatedbRunId: latestCdb?.runId ?? null, redisFixtureHash: redis.fixtureHash ?? null,
        cocreatedbFixtureHash: local?.fixtureHash ?? null,
        redisUuidReadP50Ms: redis.operations.uuidRead.p50Ms,
        cocreatedbUuidReadP50Ms: local?.operations?.uuidRead?.p50 ?? null,
        redisCreateAndIndexMs: redis.createAndIndexMs, cocreatedbCreateAndIndexMs: local?.createAndIndexMs ?? null }]
}))]))
const standardized = { runId: manifest.runId, date: manifest.startedAt, serverVersion: manifest.serverVersion, driverVersion: manifest.driverVersion,
    sourceRevision: runs[0]?.sourceRevision ?? null, runtime: runs[0]?.environment ?? null, fixtureVersion: '3.0.0',
    methodology: 'single Redis server child over loopback TCP; RDB/AOF disabled; independent String and RedisJSON plus RediSearch lanes',
    settings: { modes: manifest.modes, sampleCount: manifest.sampleCount, warmupCount: manifest.warmupCount,
        sustainedDurationMs: manifest.sustainedDurationMs, concurrencyLevels: manifest.concurrencyLevels,
        durability: 'memory only; no persistence or replication' },
    sizes: summaries, comparisonsWithLatestCocreatedb: comparisons, failures: failed }
provider.standardized ??= { methodology: 'Redis provider benchmark results; historical values remain separate', runs: [] }
const old = provider.standardized.runs.findIndex(run => run.runId === standardized.runId)
if (old < 0) provider.standardized.runs.push(standardized); else provider.standardized.runs[old] = standardized
await writeFile(providerPath, `${JSON.stringify(provider, null, 2)}\n`)

const first = runs[0]
const lines = [
    '# Redis benchmark results', '', `- Run: \`${manifest.runId}\`; ${manifest.startedAt} to ${manifest.completedAt}.`,
    `- Redis ${manifest.serverVersion}; node-redis ${manifest.driverVersion}; source revision: \`${first?.sourceRevision ?? 'unavailable'}\`.`,
    `- Runtime: ${first?.environment?.node ?? 'n/a'} on ${first?.environment?.platform ?? 'n/a'}; CPU ${first?.environment?.cpuModel ?? 'n/a'} (${first?.environment?.cpuCount ?? 'n/a'} logical CPUs).`,
    `- Workload: ${manifest.independentRunsRequested} independent trials per size and lane; ${manifest.warmupCount} warmups and ${manifest.sampleCount} samples; ${manifest.sustainedDurationMs} ms per sustained mode/concurrency; concurrency ${manifest.concurrencyLevels.join(', ')}.`,
    '- Both lanes use the same lifecycle fixture v3 and canonical input hash as CoCreateDB and MongoDB. Operations are validated against fixture-derived UUIDs and expected counts before timings are recorded.',
    '- `string` stores the serialized JSON document using Redis String SET/GET and is a direct-key value-store baseline. It has no secondary query index, so query metrics are intentionally unavailable.',
    '- `json-search` stores native JSON documents with JSON.SET/JSON.GET and indexes fixture fields using RediSearch. It covers equality, nested equality, numeric range, AND/OR filters and filtered deletion.',
    '- Each run uses a fresh Redis child and temporary directory; RDB snapshots and AOF are disabled. Redis and the Node client communicate over local TCP. Reported durability therefore differs from durable or replicated deployments.',
    '- Redis server RSS/CPU, client RSS/CPU and Redis allocator memory are reported separately. Disk I/O and Redis persistence costs are not measured. Temporary server directories are removed after each trial.',
    '- The official Ubuntu Redis 8.10.3 packages were checksum-verified and extracted under the user cache. RedisJSON and RediSearch modules from that exact package are loaded into the server process; system packages and application dependencies were not changed.', '',
    '| Lane | Size | Runs | Fixture hash | Index setup ms | Load/index ms | Redis used memory | Server loaded RSS |', '| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: |',
    ...manifest.modes.flatMap(mode => manifest.sizes.map(size => { const item = summaries[mode][size]; return `| ${mode} | ${Number(size).toLocaleString()} | ${item.successfulRuns}/${item.requestedRuns} | \`${item.fixtureHash ?? 'n/a'}\` | ${fmt(item.indexSetupMs)} | ${fmt(item.createAndIndexMs)} | ${mibs(item.redisMemoryBytes)} | ${mibs(item.serverLoadedRssBytes)} |` })),
    '', ...sections, '', '## Fixture comparison with CoCreateDB', '',
    `The CoCreateDB reference is standardized run \`${latestCdb?.runId ?? 'unavailable'}\`. Hash equality confirms identical input documents, while execution models differ: CoCreateDB is in-process memory-only; Redis uses RESP over TCP and has Redis process overhead. Redis String has no query index; the JSON/Search lane adds an explicit field index. These measurements should be read by lane and operation rather than collapsed into a single rank.`,
    '', '| Lane | Size | Same fixture hash | Redis UUID p50 ms | CoCreateDB UUID p50 ms | Redis load/index ms | CoCreateDB create/index ms |', '| --- | ---: | --- | ---: | ---: | ---: | ---: |',
    ...manifest.modes.flatMap(mode => manifest.sizes.map(size => { const item = comparisons[mode][size]; return `| ${mode} | ${Number(size).toLocaleString()} | ${item.fixtureHashMatches} | ${fmt(item.redisUuidReadP50Ms)} | ${fmt(item.cocreatedbUuidReadP50Ms)} | ${fmt(item.redisCreateAndIndexMs)} | ${fmt(item.cocreatedbCreateAndIndexMs)} |` })),
    '', '## Historical Redis project numbers', '',
    'Any pre-existing provider figures remain under `historical` in `redis.json`; they are not merged with the shared-fixture measurements because the prior dataset and raw output are not equivalent.',
    '', '## Raw results', '', `Manifest and individual runs: \`${directory}\`. Status: \`${JSON.stringify(manifest.summary)}\`. Provider data appended to [redis.json](../../providers/redis.json).`,
    '', '## Reproduce', '', '```sh', 'npm ci --prefix test/benchmarks/providers/redis',
    'npm run benchmark --prefix test/benchmarks/providers/redis', '```', '',
    'Redis 8.10.3 server packages are downloaded and checksum-verified by the runner into `~/.cache/cocreate-db-redis/8.10.3`; nothing is installed system-wide. Defaults are 1K, 10K and 100K documents, five independent trials, 40 samples, 10 warmups, 5-second sustained workloads, and concurrency 1 and 8. Override with positional sizes, `BENCH_RUNS`, `BENCH_SAMPLES`, `BENCH_WARMUPS`, `BENCH_SUSTAIN_MS`, `BENCH_CONCURRENCY`, `REDIS_BENCH_MODES` and `BENCH_OUTPUT_DIR`.',
    '', '## Failures', '', failed.length ? failed.map(item => `- ${item.mode} ${item.size} run ${item.runIndex}: ${item.failure?.message ?? item.reason ?? item.status}`).join('\n') : 'No failed trials.'
]
await writeFile(join(directory, 'report.md'), `${lines.join('\n')}\n`)
console.log(`report=${join(directory, 'report.md')}`)
console.log(`providerSummary=${providerPath}`)
