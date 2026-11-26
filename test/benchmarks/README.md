# CoCreateDB benchmarks

The benchmark layout separates same-fixture provider comparisons from CoCreateDB-only diagnostics. The v3 provider fixture and historical results are retained unchanged.

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
    │   └── results/                        Diagnostic result files and prior diagnostic logs
    ├── baselines/                          Preserved historical baselines
    └── providers/<provider>/               Adapter, configuration, summary and raw results
```

## Standard benchmark

The standard dataset sizes are **10,000, 100,000, and 1,000,000 leaves**. The default is five independent runs per size, 40 measured samples and 10 warmups per latency operation, five-second sustained read/write/mixed windows, and concurrency levels 1 and 8. The v3 fixture, CRUD operations, query predicates, index coverage, validation, and sustained workload definitions are shared across providers and have not been changed by this reorganization.

Run CoCreateDB:

```sh
npm run benchmark:standard
```

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
```

The diagnostics use `diagnostics/fixtures/residency.mjs`, a richer nested and variable-size fixture that is deliberately separate from the standard provider fixture. Weighted eviction measures index-branch and leaf eviction, disk bytes, hydration, memory and correctness. Deferred indexing measures create, direct UUID read, indexed equality read, update and delete acknowledgement, post-ack index drain, local disk flush, and per-kind leaf/branch/config disk operation counts, bytes and latency percentiles. Create uses generated UUIDs; reads, updates and deletes target those same resident UUIDs. Indexed equality reads sample up to 10K distinct leaves. The benchmark exercises the local Node DB API, not network round trips, client replication or external Persistence. Continuous diagnostics collect mixed CRUD latency, memory samples, policy state, disk usage, swap counters and GC events. `test/weights.test.js` checks ordered weight buckets, lowest-weight selection and skips for candidates touched during an asynchronous eviction. Diagnostic outputs are timestamped under `diagnostics/results/`.

The default requested memory budget is 25% of detected system RAM, capped at startup by memory available to the OS. It is an adaptive pressure target, not a hard RSS cap: eviction is asynchronous and may lag the workload. The DB mode and response acknowledgement are configured independently. Modes are `adaptive` (default), `disk-first`, and `disk-cache`; acknowledgements are `memory` (default) and `disk`. `disk-first` hydrates and processes requests from local Warm state, then writes and prunes it. `disk-cache` uses adaptive Hot/Warm behavior but clears only its managed Warm cache on startup. A `disk` acknowledgement waits for local writes; it does not select or change the mode. External Persistence acknowledgement is not implemented yet. The query-locality diagnostic accepts `--database-mode=adaptive|disk-first|disk-cache` and `--acknowledgement=memory|disk`. These measurements remain separate from standardized provider timings.

## Selected CoCreateDB baseline

The selected current-dev baseline is the three-run 100K standard measurement in [`providers/cocreatedb/results/baseline-dev-100k-2026-11-25/`](providers/cocreatedb/results/baseline-dev-100k-2026-11-25/). It uses the shared v3 fixture, adaptive mode, memory acknowledgement, 40 samples and 10 warmups per latency operation, 1-second sustained phases, and concurrency 1. Earlier CoCreateDB standard result artifacts were removed when this baseline was selected. Separate diagnostic outputs and other provider comparison results remain separate from this baseline. Regenerate its report only from its raw run manifest and result files.

### Query field locality

Run each mode against the same wide fixture and seeded record sequence:

```sh
node test/benchmarks/diagnostics/query-locality.mjs --mode=focused --records=100000
node test/benchmarks/diagnostics/query-locality.mjs --mode=scattered --records=100000
```

By default, each record has 40 queryable fields plus a revision and a variable size payload, and both modes run one equality read per create batch, followed by 12,000 mixed requests after loading. Focused mode queries four fixed fields. Scattered mode selects from all 40. Both modes select records from the same broad set so the comparison isolates field choice. Set `--focused-fields` to 1–4, `--fields` to change fixture width, `--requests` to change the steady phase length, or `--leaf-size` to compare leaf capacities with branch capacity fixed at 1,024.

The diagnostic defaults to the engine’s 25% memory budget and reports Hot leaves, Warm leaves, and Warm index branches with their read/write counts. Adaptive mode offloads under memory pressure; disk-first uses local Warm state per request and prunes it after processing. The independent acknowledgement setting controls whether the call returns after the Hot mutation or waits for local Warm writes. Results contain RSS, operation latency, and index branch reads and writes by field. The diagnostic also reports total and Warm index entries per field after growth and before a point query verifies that a previously unused Warm index branch can reload. Reads are attributed to the synchronous CRUD path or background processing. Use `BENCH_OUTPUT_DIR` to place the result and temporary DB files outside the checkout. Run Node with `--expose-gc` to sample whether offloaded entries are still reachable and report heap and RSS after a final forced collection. The forced collection runs after the timed workload.
