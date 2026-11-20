# CoCreateDB benchmark suite

The standardized suite currently benchmarks CoCreateDB only. It preserves the original v2 lifecycle benchmark and its historical results; the standardized fixture is a separate v3 lane.

## Run

From the module root:

```sh
npm test
npm run benchmark:standard
```

The standard runner defaults to 1,000, 10,000, 100,000 and 1,000,000 objects, five independent child processes per size, 10 warmups and 40 timed samples per individual operation. It also runs five v2 compatibility samples at 1,000 records so the retained historical summary has an equivalent-workload reference. Each child starts with a fresh DB and configuration. The runner stops repeating a size after a failed attempt, records the failure, and marks unattempted runs explicitly.

Choose sizes or tune duration for a smoke run:

```sh
npm run benchmark:standard -- 1000,10000
BENCH_RUNS=1 BENCH_SUSTAIN_MS=100 BENCH_CONCURRENCY=1,2 npm run benchmark:standard -- 1000
```

The standard policy floors individual latency measurements at 40 samples and 10 warmups. Environment controls:

- `BENCH_RUNS`: independent runs per dataset size; default 5.
- `BENCH_SAMPLES`: measured samples per individual operation; default 40, minimum 40.
- `BENCH_WARMUPS`: warmup operations per individual operation; default 10, minimum 10.
- `BENCH_SUSTAIN_MS`: duration of each sustained workload/concurrency pair; default 1,000 ms.
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

Raw results include package/source revision, runtime, OS, CPU model/count, RAM and detected memory limit, configuration, sample policy, fixture version/hash, dataset size, CPU time/utilization, idle/loaded/peak RSS, incremental memory per object and failure metadata. A failed/oom-killed subprocess is retained in the run manifest rather than silently omitted. Run directories include raw JSON, a manifest and generated report. `providers/cocreatedb.json` appends standardized summaries while keeping the prior v2 baseline; MongoDB, Redis, Couchbase, CouchDB and CockroachDB historical references are not treated as controlled comparisons.

## Competitor phase

Do not install or run competitors as part of the CoCreateDB-only phase. Add provider-specific code and measured results only when each provider is benchmarked. Match dataset hash, result count, selected fields, index coverage, concurrency, process/network boundary, durability and acknowledgment semantics. Keep server and client resource use separate when they run in separate processes. Do not rank operations whose guarantees differ.

Distributed synchronization, replication, sharding, recovery and transactional coordination are reserved for later phases. Historical snapshots in `baselines/2026-11-19-final` and previous dated results are retained; they are references, not substitutes for same-host standardized runs.
