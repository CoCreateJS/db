# CoCreateDB benchmark suite

The standardized suite preserves CoCreateDB's original v2 lifecycle benchmark and historical results, and adds a v3 fixture shared with MongoDB and Redis provider benchmarks. Other database providers remain historical-only until their individual adapters are built and measured.

## Run

From the module root:

```sh
npm test
npm run benchmark:standard
```

The standard runner defaults to 1,000, 10,000 and 100,000 objects, five independent child processes per size, 10 warmups and 40 timed samples per individual operation. It also runs five v2 compatibility samples at 1,000 records so the retained historical summary has an equivalent-workload reference. Each child starts with a fresh DB and configuration. The runner stops repeating a size after a failed attempt, records the failure, and marks unattempted runs explicitly.

Choose sizes or tune duration for a smoke run:

```sh
npm run benchmark:standard -- 1000,10000
BENCH_RUNS=1 BENCH_SUSTAIN_MS=1000 BENCH_CONCURRENCY=1,2 npm run benchmark:standard -- 1000
```

The standard policy floors individual latency measurements at 40 samples and 10 warmups. Environment controls:

- `BENCH_RUNS`: independent runs per dataset size; default 5.
- `BENCH_SAMPLES`: measured samples per individual operation; default 40, minimum 40.
- `BENCH_WARMUPS`: warmup operations per individual operation; default 10, minimum 10.
- `BENCH_SUSTAIN_MS`: duration of each sustained workload/concurrency pair; default 5,000 ms, minimum 1,000 ms.
- `BENCH_CONCURRENCY`: comma-separated outstanding request levels; default `1,8`.
- `BENCH_LEGACY_RUNS`: independent v2 comparison runs at 1,000 records; defaults to `BENCH_RUNS`.
- `BENCH_OUTPUT_DIR`: override the dated run directory.

To regenerate the Markdown report and append a CoCreateDB provider summary without replacing historical measurements:

```sh
npm run benchmark:report -- test/benchmarks/runs/standard-<run-id>
```

## Dataset and correctness

`test/fixtures/lifecycle.mjs` retains the original v2 fixture unchanged and adds a programmatic v3 record generator. V3 includes IDs, nested objects, arrays, strings, variable-size payloads, numbers, booleans and timestamps. Fixture data is created in batches of 1,000; no generated dataset is stored in Git. Each raw run records a canonical fixture SHA-256.

Before collecting latency samples, the runner checks UUID lookup, equality, nested equality, numeric range, indexed AND/OR selections, index-updating mutations, individual deletion and filtered bulk deletion against expected UUIDs/counts. Query measurements use the same 100-result limit. The legacy v2 lane uses the unchanged `test/benchmarks/lifecycle.mjs` workload and its existing predicates.

Individual latency results include first operation, warm min/max/mean, p50/p95/p99, total sample time and operations/second. The suite also measures initialization/readiness, first and warm single creates, bulk create plus synchronous indexing, single and indexed-key updates, numeric increments, individual and filtered deletion, and sustained read/write/mixed traffic at each concurrency level.

## Measurement boundaries

The initial phase is single-process, in-memory CoCreateDB. Benchmark client and DB share the same Node process; concurrency is outstanding requests, not parallel database threads. There is no persistence provider, disk activity, IPC, network, durability guarantee, transaction coordination, replication or sharding in these measurements. Disk usage and I/O are reported as not applicable. Create-and-index includes all synchronous index work; there is no separate flush.

Raw results include package/source revision, runtime, OS, CPU model/count, RAM and detected memory limit, configuration, sample policy, fixture version/hash, dataset size, CPU time/utilization, idle/loaded/peak RSS, incremental memory per object and failure metadata. A failed/oom-killed subprocess is retained in the run manifest rather than silently omitted. Run directories include raw JSON, a manifest and generated report. `providers/cocreatedb.json` appends standardized summaries while keeping the prior v2 baseline; provider references should be compared by operation and execution boundary.

## MongoDB, Redis and subsequent providers

MongoDB's isolated adapter in `test/benchmarks/providers/mongodb/` creates a standalone temporary WiredTiger database and records its index definitions, server/client resource use, and raw results. Redis's isolated adapter in `test/benchmarks/providers/redis/` measures Redis String JSON-text GET/SET and RedisJSON plus RediSearch as separate lanes, with a pinned Redis 8.10.3 server. It stores the same full fixture in each lane; the String lane has no secondary-query index, while the JSON/Search lane indexes the fixture paths. Both providers have independent dated reports and raw runs. Couchbase, CouchDB and CockroachDB have not been run under this suite. Match dataset hash, result count, selected fields, index coverage, concurrency, process/network boundary, durability and acknowledgment semantics. Keep server and client resource use separate when they run in separate processes. Do not rank operations whose guarantees differ.

Run the MongoDB baseline from the module root:

```sh
npm ci --prefix test/benchmarks/providers/mongodb
npm run benchmark --prefix test/benchmarks/providers/mongodb
```

Run the Redis baseline from the module root:

```sh
npm ci --prefix test/benchmarks/providers/redis
npm run benchmark --prefix test/benchmarks/providers/redis
```

Distributed synchronization, replication, sharding, recovery and transactional coordination are reserved for later phases. Historical snapshots in `baselines/2026-11-19-final` and previous dated results are retained; they are references, not substitutes for same-host standardized runs.

## Current scale results

The latest five-second sustained CoCreateDB run is [2026-11-20T06-10-08.681Z](runs/standard-2026-11-20T06-10-08.681Z/report.md). Five 1,000-, 10,000- and 100,000-object runs passed at each size. A prior 1,000,000-object attempt hit Node.js's JavaScript heap limit at about 2 GiB; it is recorded in [2026-11-20T01-04-18.943Z](runs/standard-2026-11-20T01-04-18.943Z/report.md) and excluded from the default run sizes for now. The MongoDB same-fixture baseline is [2026-11-20T04-08-28.702Z](runs/mongodb-standard-2026-11-20T04-08-28.702Z/report.md); Redis String and RedisJSON/RediSearch results are in [2026-11-20T04-58-00.174Z](runs/redis-standard-2026-11-20T04-58-00.174Z/report.md).

### Query field locality

Run each mode against the same wide fixture and seeded record sequence:

```sh
node test/benchmarks/diagnostics/query-locality.mjs --mode=focused --records=100000
node test/benchmarks/diagnostics/query-locality.mjs --mode=scattered --records=100000
```

By default, each record has 40 queryable fields plus a revision and a variable size payload, and both modes run one equality read per create batch, followed by 12,000 mixed requests after loading. Focused mode queries four fixed fields. Scattered mode selects from all 40. Both modes select records from the same broad set so the comparison isolates field choice. Set `--focused-fields` to 1–4, `--fields` to change fixture width, `--requests` to change the steady phase length, or `--leaf-size` to compare leaf capacities with branch capacity fixed at 1,024.

Both modes use the engine’s automatic offload at `--memory=25`. Results contain RSS, operation latency, and index partition reads, writes, and remaining cold partitions by field. It also reports total and cold index entries per field after growth and before a final point query that verifies a previously unused cold leaf can reload. Reads are attributed to the synchronous CRUD path or background processing. Use `BENCH_OUTPUT_DIR` to place the result and temporary DB files outside the checkout. Run Node with `--expose-gc` to sample whether offloaded entries are still reachable and report heap and RSS after a final forced collection. The forced collection runs after the timed workload.
