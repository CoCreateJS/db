# CoCreateDB benchmarks

The benchmark layout separates same-fixture provider comparisons from CoCreateDB-only diagnostics. The v3 provider fixture is shared across providers. Current CoCreateDB baselines are listed in [the baseline catalog](providers/cocreatedb/results/README.md).

```text
test/
├── fixtures/lifecycle.mjs                 Shared deterministic fixture definitions
└── benchmarks/
    ├── standard.mjs                       CoCreateDB standard provider-comparison runner
    ├── standard-report.mjs                Standard CoCreateDB report/history writer
    ├── lifecycle.mjs                      Legacy v2 comparison runner
    ├── shared/                             Sizes, expected workloads, progress, child watchdog
    ├── diagnostics/                       CoCreateDB-only range/residency diagnostics
    │   ├── fixtures/residency.mjs          Diagnostic-only fixture; separate from v3
    └── providers/<provider>/               Adapter, configuration, summary and raw results
```

## Standard benchmark

The standard dataset sizes are **10,000, 100,000, and 1,000,000 leaves**. The default is five independent runs per size, 40 measured samples and 10 warmups per latency operation, five-second sustained read/write/mixed windows, and concurrency levels 1 and 8. The v3 fixture, CRUD operations, query predicates, index coverage, validation, and sustained workload definitions are shared across providers and have not been changed by this reorganization.

Run CoCreateDB:

```sh
npm run benchmark:standard
```

The CoCreateDB runner uses the public `DB.init()` entry and sends timed requests through `db.send()` through organization routing to the selected primary's `tree.execute()`. It asserts the thin DB shape, verifies organization routing and independent primary Tree access, and runs direct Tree create/read/update/delete checks after the timed workloads. Queue completion and telemetry are observed through internal diagnostics; request processing uses the public API. Raw metadata records whether the working tree contains uncommitted changes.

Run one 100K public API pass with the standard sustained settings:

```sh
BENCH_RUNS=1 BENCH_INDEX_PROGRESS_MS=10000 \
  npm run benchmark:standard -- 100000
```

The queue observation timeout defaults to ten minutes in the benchmark and can be overridden with `BENCH_INDEX_TIMEOUT_MS`. This does not alter engine scheduling.

Run one standard size for a smoke/correctness pass:

```sh
BENCH_RUNS=1 BENCH_SUSTAIN_MS=1000 BENCH_CONCURRENCY=1 \
  npm run benchmark:standard -- 10000
```

Completion-based work (bulk create/index and finite CRUD samples) runs until all requested records or operations finish. There is no total elapsed-time cutoff. `BENCH_STALL_MS` is an inactivity watchdog, reset by child-process output; it terminates a genuinely stalled run while allowing a slow but progressing 1M workload to complete. Bulk-load progress is emitted in bounded intervals. Sustained throughput remains a separate fixed-duration measurement.

Common settings are `BENCH_RUNS`, `BENCH_SAMPLES`, `BENCH_WARMUPS`, `BENCH_SUSTAIN_MS`, `BENCH_CONCURRENCY`, `BENCH_STALL_MS`, and `BENCH_OUTPUT_DIR`. The standard sizes are enforced by the standard runner; smaller fixture sizes remain available to correctness tests and the separate legacy v2 comparison lane (`BENCH_LEGACY_RUNS`).

Raw trial JSON, manifests and reports are written inside that provider's `results/` directory. Historical runs that used the former shared `runs/` path have been moved without changing their raw measurements. Provider summary history remains append-only in each provider's `results/summary.json`. The provider adapters keep their own database setup and configuration; those differences are documented in each provider README.

## Measurements and comparability

The suite records initialization/readiness, first and bulk creation, create/index throughput, UUID/equality/nested/range/complex-filter reads, updates, deletion, latency percentiles, sustained read/write/mixed throughput, total time, memory, CPU, fixture hash, source revision, correctness status, and provider-specific outstanding work when the adapter exposes it. Sustained concurrency is outstanding requests; a single-process CoCreateDB result does not imply parallel database threads.

The standard provider lane uses the single queued, batched indexing path. The report separates create acknowledgement from the final index drain, and create-plus-index includes both. The standalone indexing-queue diagnostics measure different workloads and should not be compared directly with standard totals.

The standard CoCreateDB lane is memory-only and in-process. Provider lanes use their documented transport, indexing, durability and process boundaries. Compare only matching fixture hashes and operation semantics; retain the provider-specific costs rather than treating the output as a direct ranking. The one-million case is included in standard runs and may fail under a host's memory limit; the manifest preserves failures and stops later sizes only when resource exhaustion makes continuing unsafe.

## CoCreateDB diagnostics

Diagnostic benchmarks are separate from provider summaries and do not alter the standard fixture or its results.

```sh
npm run benchmark:ranges
npm run benchmark:weighted-eviction -- 10000 0.5
npm run benchmark:deferred-indexing -- 10000
npm run benchmark:continuous -- 10000
npm run benchmark:index-lifecycle
```

The diagnostics use `diagnostics/fixtures/residency.mjs`, a richer nested and variable-size fixture that is deliberately separate from the standard provider fixture. Weighted eviction measures index-branch and leaf eviction, disk bytes, hydration, memory and correctness. Deferred indexing measures create, direct UUID read, indexed equality read, update and delete acknowledgement, post-ack index drain, local disk flush, and per-kind leaf/branch/config disk operation counts, bytes and latency percentiles. Create uses generated UUIDs; reads, updates and deletes target those same resident UUIDs. Indexed equality reads sample up to 10K distinct leaves. The benchmark exercises the local Node DB API, not network round trips, client replication or external Persistence. Continuous diagnostics collect mixed CRUD latency, memory samples, policy state, disk usage, swap counters and GC events. `test/weights.test.js` checks ordered weight buckets, lowest-weight selection and skips for candidates touched during an asynchronous eviction. Diagnostic outputs are timestamped under `diagnostics/results/`.

The index-lifecycle diagnostic defaults to one organization, 80 independent primary arrays, and 5,000 records per array. It reports per-second CRUD request/record acknowledgements and all disk adapter operation rates, then measures the overlapping create-and-index lifecycle until all records are acknowledged and `pendingIndexCount` reaches zero. Host-wide average CPU comes from `/proc/stat` across all logical CPUs. Disk operation counts and rates, write bytes, and remaining disk queue items are sampled each second and at the endpoint; the runner terminates without waiting for disk drain. Its current workload is create-only, so read/update/delete phases are explicitly marked not run. These results describe index readiness and outstanding storage work, not completed persistence.

### System capacity benchmark

The system capacity benchmark is a separate versioned fixture and real-worker workload for an end-to-end capacity profile. It measures bulk create acknowledgement latency and records/s, the additional index-drain time, UUID point reads, indexed rank equality reads, update and delete acknowledgement latency and ops/s, a configurable concurrent 25/25/25/25 mixed CRUD window, overall acknowledged request throughput, queue depths, and disk adapter operation counts, bytes, failures and rates during acknowledgement and index-drain windows. It samples whole-host CPU and available memory, primary/worker RSS and heap, per-process CPU, and event-loop delay. The endpoint is taken after the index queues drain; local disk drain is deliberately not awaited, and its pending item count is reported.

Run the default 100K profile (one organization, eight primary arrays, eight workers, 10K point operations per CRUD type):

```sh
npm run benchmark:system-capacity
```

The raw result, run metadata, progress log, and Markdown summary are saved together under `providers/cocreatedb/results/system-capacity-<timestamp>/`. Set `DB_RECORDS`, `DB_GROUPS`, `DB_ORGANIZATIONS`, `DB_WORKERS`, `DB_CRUD_OPERATIONS` (or `all`), `DB_CRUD_CONCURRENCY`, `DB_MIXED_MS`, `DB_MIXED_CONCURRENCY`, and `DB_RANDOMIZE_ARRAYS` to shape a run. `DB_OUTPUT_DIR` selects an output directory. For example, the prior 80-array topology with 25K records each can use `DB_RECORDS=2000000 DB_GROUPS=80 DB_WORKERS=8`; do not use that scale without checking host capacity.

The fixture version is recorded in every result; it is not comparable to the shared v3 provider fixture or older lifecycle reports. CRUD point phases use disjoint slices of loaded records, and the mixed workload uses a separate pool. Disk adapter metrics represent local adapter calls, not external Persistence calls or durable completion. This runner does not currently instrument network request ingress or an external persistence provider. The benchmark is an implementation artifact only until explicitly run; saved reports must include the exact run metadata and source revision when comparing changes.

The default requested memory budget is 25% of detected system RAM, capped at startup by memory available to the OS. It is an adaptive pressure target, not a hard RSS cap: eviction is asynchronous and may lag the workload. The DB mode and response acknowledgement are configured independently. Modes are `adaptive` (default), `disk-first`, and `disk-cache`; acknowledgements are `memory` (default) and `disk`. `disk-first` hydrates and processes requests from local Warm state, then writes and prunes it. `disk-cache` uses adaptive Hot/Warm behavior but clears only its managed Warm cache on startup. A `disk` acknowledgement waits for local writes; it does not select or change the mode. External Persistence acknowledgement is not implemented yet. The query-locality diagnostic accepts `--database-mode=adaptive|disk-first|disk-cache` and `--acknowledgement=memory|disk`. These measurements remain separate from standardized provider timings.

## Selected CoCreateDB baseline

The current baseline catalog is [`providers/cocreatedb/results/README.md`](providers/cocreatedb/results/README.md). It retains the latest 10K, 100K, 200K, and concurrent two-organization measurements, with their raw results. The primary 100K baseline is [`standard-2026-11-26T18-39-36.192Z/`](providers/cocreatedb/results/standard-2026-11-26T18-39-36.192Z/). Superseded CoCreateDB results and diagnostic logs were removed; other provider results remain separate. Regenerate reports from their retained manifests and raw files. These are single-run baselines; match workload settings and repeat measurements for comparisons.

The runner also accepts an explicit 200K size (`node test/benchmarks/standard.mjs 200000`). To run the concurrent organization diagnostic, set `BENCH_ORGANIZATIONS` (default 2) and pass the records per organization: `BENCH_ORGANIZATIONS=4 node test/benchmarks/diagnostics/parallel-organizations.mjs 100000`.

The real-worker fixture runner also accepts `DB_WORKERS` (up to 16), `DB_ORGANIZATIONS`, total `DB_GROUPS` arrays, and total `DB_RECORDS`. `DB_RANDOMIZE_ARRAYS=1` uses a deterministic per-organization shuffle to spread each organization's records evenly across its arrays. For example, two million records across 80 organizations, four arrays per organization, and eight workers:

```sh
NODE_OPTIONS=--max-old-space-size-percentage=75 DB_WORKERS=8 DB_ORGANIZATIONS=80 DB_GROUPS=320 DB_RECORDS=2000000 DB_RANDOMIZE_ARRAYS=1 \
  node test-support/worker-db.mjs
```

Each result includes five-second CPU and RSS samples for the primary and every worker. CPU utilization is relative to one logical core. Set `DB_LOAD_ONLY=1` to save a large ingestion/indexing result after queue-drain, placement, and primary-residency checks without running the additional CRUD/pruning diagnostic operations afterward.

### Query field locality

Run each mode against the same wide fixture and seeded record sequence:

```sh
node test/benchmarks/diagnostics/query-locality.mjs --mode=focused --records=100000
node test/benchmarks/diagnostics/query-locality.mjs --mode=scattered --records=100000
```

By default, each record has 40 queryable fields plus a revision and a variable size payload, and both modes run one equality read per create batch, followed by 12,000 mixed requests after loading. Focused mode queries four fixed fields. Scattered mode selects from all 40. Both modes select records from the same broad set so the comparison isolates field choice. Set `--focused-fields` to 1–4, `--fields` to change fixture width, `--requests` to change the steady phase length, or `--leaf-size` to compare leaf capacities with branch capacity fixed at 1,024.

The diagnostic uses the composer’s node-wide memory policy and reports Hot leaves, Warm leaves, and Warm index branches with their read/write counts. Adaptive mode offloads under memory pressure; disk-first uses local Warm state per request and prunes it after processing. The independent acknowledgement setting controls whether the call returns after the Hot mutation or waits for local Warm writes. Results contain RSS, operation latency, and index branch reads and writes by field. The diagnostic also reports total and Warm index entries per field after growth and before a point query verifies that a previously unused Warm index branch can reload. Reads are attributed to the synchronous CRUD path or background processing. Use `BENCH_OUTPUT_DIR` to place the result and temporary DB files outside the checkout. Run Node with `--expose-gc` to sample whether offloaded entries are still reachable and report heap and RSS after a final forced collection. The forced collection runs after the timed workload.

Memory policy instrumentation uses node-wide used-memory percentages, matching
Telemetry's contract. On Linux the benchmark uses `MemAvailable` so reclaimable
page cache is accounted for. Process RSS and heap are reported separately and
are not used as a DB memory allocation. Results from the earlier allocation
policy remain historical measurements and should be identified when compared.

### Worker execution comparison

```sh
node test/benchmarks/diagnostics/workers.mjs 10000
```

Runs the same deterministic 10K fixture across four primary tables in one
organization, first with one execution worker, then with two. Both use an
orchestrating primary and the existing CoCreate Cluster IPC implementation
(`@cocreate/cluster/src/send/ipc.js`, available in the development workspace).
No mock transport or new IPC implementation is used. Workers are ready before
DB traffic; this does not test production cluster startup ordering.

The fixture asserts stable round-robin placement, zero primary-local Trees,
worker ingress, query/sort/pagination, CRUD and organization isolation, worker-local
pruning, pending-storage protection, stop-at-50% controls and selective cold reads.
Explicit asynchronous queue diagnostics establish completion outside CRUD.
Reports include acknowledgement wall time, create-and-index wall time, process
memory samples and matching fixture hashes. One sample per worker count is an
architectural check, not a scaling claim or a comparison to the old one-table
standard baseline. Set `BENCH_OUTPUT_DIR` to select the output directory.

### Independent disk queue timing

Current runners distinguish index readiness (`createAndIndexMs`) from disk/Persistence completion (`createAndStorageMs`). The internal `pendingIndexCount` excludes storage; `pendingDiskCount` includes pending and in-flight file operations until the storage batch completes. Tests that require saved files or pruning eligibility use `waitForIdle`; reads never call either observation helper. Historical results are unchanged. A matched 10K comparison is in [disk-queue-10k-2026-11-27T16-05-15](providers/cocreatedb/results/disk-queue-10k-2026-11-27T16-05-15/report.md).
