# CoCreateDB indexing and query performance

Run date: 2026-11-18. Raw output: `sustained-2026-11-18T23-33-04.231Z.json`.

## Changes measured

- Cached deterministic array, catalog, index-node, and partition paths. A bounded absolute-path cache avoids repeatedly normalizing the same artifact paths during memory and persistence access.
- Passed field/type roots already resolved by the query planner into index scans, avoiding a second catalog walk.
- For unsorted, unsearched filtered reads with a positive limit, verify candidates as they are loaded and stop after the requested page is filled. This shortcut is disabled while the scope has queued index work.
- Avoided re-hashing a queued document's full index state for every subsequent update. The first pre-update index state remains the reconciliation baseline; every update patch remains queued.
- Kept final document-level query checks for broad candidate sets. Dotted paths fall back to all candidates when an ancestor can be an array, preventing false negatives.

## Comparable 1,000-document measurements

The lifecycle benchmark uses the same memory-only fixture and 40 measured read/update samples per run.

| Metric | Earlier run | Latest run |
| --- | ---: | ---: |
| Initial index flush | 8.22 s | 2.95 s |
| UUID read p50 | 0.286 ms | 0.166 ms |
| Equality read p50 | 3.66 ms | 2.81 ms |
| Nested-path read p50 | 2.21 ms | 1.63 ms |
| Unbounded range read p50 | 8.15 ms | 6.68 ms |

The initial index flush is about 64% faster. The final CPU profile no longer showed `path.resolve` among the largest costs: its sampled self time fell from about 895 ms after the first path-cache pass to 65 ms after caching repeated absolute paths. Remaining visible work included index scans, path joins for new addresses, in-memory JSON reads/writes, persistence artifact lookup, and catalog/leaf updates. `insertNode` was about 64 ms self time, while nested value digest generation did not rank among the top 25 sampled functions, so neither leaf insertion nor hashing justified a higher-risk rewrite in this pass.

## Sixty-second sustained workload

Configuration: 1,000 documents, filesystem persistence enabled, `writeBehind: true`, no peers or external persistence, one Node process on a 2-core Linux host. Reads alternate UUID lookup and a limited range query. Writes increment `revision` on existing UUIDs. Each write phase drains indexing and persistence separately after the 60-second measurement.

| Workload | Concurrency | Ops/s | p50 | p95 | p99 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Read | 1 | 456 | 3.83 ms | 4.51 ms | 5.58 ms |
| Read | 4 | 466 | 8.42 ms | 12.89 ms | 13.50 ms |
| Read | 16 | 460 | 34.47 ms | 39.54 ms | 43.19 ms |
| Write acknowledgment | 1 | 2,845 | 0.32 ms | 0.38 ms | 0.51 ms |
| Write acknowledgment | 4 | 2,557 | 1.46 ms | 1.61 ms | 2.72 ms |
| Write acknowledgment | 16 | 2,642 | 5.64 ms | 6.81 ms | 13.66 ms |

Initial 1,000-object insertion acknowledged in 747 ms; index construction took 2.46 s and persistence flush took 1.06 s. First cold UUID read was 23.2 ms; its repeated warm read was 0.89 ms.

Each write phase reached a peak of 1,000 pending document index entries and drained to zero. Index processing took 1.06 s, 0.77 s, and 0.73 s at concurrency 1, 4, and 16. Persistence drains took 0.94 s, 0.94 s, and 0.92 s. CPU stayed near 100–105% of one core (about half the available two-core machine). Peak RSS was 607 MB and peak sampled heap use was 357 MB.

The prior sustained baseline on the same 1,000-document workload delivered about 75 reads/s with p95 26.8 ms at concurrency 1. Limited range reads now stop after verifying enough matching records, raising the mixed read rate to about 456 reads/s. Total read throughput stays close to one core's capacity as concurrency rises; latency grows with queued callers. Write throughput remains around 2.6k acknowledgments/s, and index/persistence work drains after each measured phase.

## Verification

Passing focused suites: lifecycle (2), update changes (10), index CRUD and request resolution (6), and property paths (1). Query planner suite passed its catalog, array-operator, planner, and bounded-scan checks; its legacy `_id`-only create case still fails because this implementation requires a UUID file ID.

`npm test` is not a usable full-suite command in this checkout: Node discovers benchmark runners and archived source snapshots under `test/benchmarks` as tests. Some require a missing sibling CoCreate App file, and an older benchmark parses CoSON binary as JSON. The command was interrupted after exposing those harness issues; benchmark runs above were executed directly.
