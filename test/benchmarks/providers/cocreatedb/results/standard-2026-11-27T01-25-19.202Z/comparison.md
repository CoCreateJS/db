# Query planning and selective hydration: validation report

The comparison uses the retained pre-planner worktree run and the final planner build. Both are based on dev checkpoint `25acd763`, with uncommitted changes. This compares dev worktree results, not the stale fastest branch.

## Implemented behavior

- Pure replaceable planner: AND intersections, OR unions/deduplication, NOT/NOR complements, safe scalar range bounds and residual predicates. Shared Utils owns query and sorting semantics.
- Existing Filter/IndexedDB shape: query, ordered sort entries `{ key, direction }`, startingIndex/index, limit (0 is unbounded); the response reports startingIndex and next index.
- Covered unsorted queries stream index matches and probe other indexes; explicit multi-field sorting collects indexed sort values before pagination.
- Settled covered matches are not checked against their payloads again. Whole-document predicates, nonempty container operations, search and container sorts can require residual evaluation and additional payload reads. Pending payload mutations are rechecked; reads remain eventually consistent and do not wait for indexing.
- Stored index branches restore UUID/value entries without document reads. Disk hydration never schedules reindexing. Scalar mutations attach only affected old entries; complex mutations/deletes restore their required old positions.
- Empty arrays/objects have typed index values, so missing fields, existence predicates and sorting remain distinct.
- Active counts protect primary subtrees through planning, hydration and stream consumption. Finally blocks release counts on success, failure and iterator closure. Filtered mutations collect UUIDs before changing driving index values.

## Correctness

`npm test`: **56 passed, 0 failed**. Tests cover hot/cold parity with Utils, compound ranges, mixed types/coercion, AND/OR/NOR, null/missing/empty containers, array paths and residuals, multiple sort fields/directions, pagination aliases, search, cold updates/deletes, concurrent active reads, early stream closure and mutation/indexing interleaving. A cold three-document page reads exactly three document payload files, touches no unrelated column roots, writes no files and leaves the index queue at zero.

## 10K standard comparison

One organization; identical 10,000-record v3 fixture; local Disk enabled; external Persistence absent; size/leafSize 64; 1,000-record input chunks. Commands used `BENCH_RUNS=1 BENCH_INDEX_PROGRESS_MS=10000 node test/benchmarks/standard.mjs 10000`. Baseline and updated are single runs separated in time. Percentages are observations, not stable estimates or isolated causal measurements.

| Measurement | Before planner | Updated | Change |
| --- | ---: | ---: | ---: |
| Create acknowledgement | 1.102 s | 1.137 s | +3.1% |
| Index drain after creates | 7.076 s | 7.514 s | +6.2% |
| Create + index, including fixture generation | 8.286 s | 8.773 s | +5.9% |
| Peak process RSS | 256.7 MiB | 264.0 MiB | +2.8% |

Mean latency per request in milliseconds; lower is faster. Query cases return up to 100 records; UUID reads and single mutations operate on one record. Bulk delete shows the elapsed time for 25 records.

| Operation | Before planner | Updated | Change |
| --- | ---: | ---: | ---: |
| uuidRead | 0.0362 | 0.0984 | +171.7% |
| equality | 1.8595 | 2.1114 | +13.5% |
| nestedEquality | 1.9949 | 2.1701 | +8.8% |
| numericRange | 1.1673 | 2.2589 | +93.5% |
| and | 1.0069 | 3.0674 | +204.6% |
| or | 2.8937 | 1.9817 | -31.5% |
| singleCreate | 0.3277 | 0.3954 | +20.6% |
| singleKeyUpdate | 0.1003 | 0.1214 | +21.1% |
| indexedKeyUpdate | 0.0922 | 0.1056 | +14.5% |
| numericIncrement | 0.1058 | 0.2346 | +121.7% |
| singleDelete | 0.0195 | 0.0336 | +72.7% |
| filteredBulkDelete | 0.9923 | 2.0527 | +106.9% |

The richer engine has measurable hot-path costs in this run. Compound index probes and operation lifecycle work are candidates for profiling; this comparison does not isolate their individual costs. The report does not claim an across-the-board speedup. The cold-hydration and queue-amplification fix is established separately by correctness/instrumentation checks. Profiling these hot costs is a subsequent optimization task.

Sustained throughput is operations/second; higher is faster. Each case ran five seconds.

| Workload / concurrency | Before planner | Updated | Change |
| --- | ---: | ---: | ---: |
| read / 1 | 87,180 | 58,296 | -33.1% |
| write / 1 | 19,487 | 15,491 | -20.5% |
| mixed / 1 | 31,931 | 24,703 | -22.6% |
| read / 8 | 113,294 | 79,039 | -30.2% |
| write / 8 | 24,680 | 23,060 | -6.6% |
| mixed / 8 | 40,518 | 32,293 | -20.3% |

## Ten-organization cold-read smoke

Command: `BENCH_ORGANIZATIONS=10 BENCH_PRUNE_BEFORE_READS=1 node test/benchmarks/diagnostics/parallel-organizations.mjs 1000`. This is 1,000 records per organization, **10,000 total**, not another million-record run. Each Tree was pruned before validation reads.

| Queue observation | Pending |
| --- | ---: |
| After initial indexing | 0 |
| After cold UUID/indexed reads | 0 |
| Before final mutation drain | 1 |
| After final drain | 0 |

Final drain: **48.13 ms**. UUID reads, indexed reads, organization directories and update/delete isolation passed. The reads did not recreate the index backlog. This does not establish million-record throughput or behavior at 75% real machine pressure.

## Scope and remaining boundaries

No SQL backend was introduced. Utils is unchanged. Query sorting is exact for indexed values; live payloads may be newer while indexing is queued, and reads are not snapshots. Residual predicates/container sorts can hydrate more than the final page. Primary pruning still requires recoverable local Disk; persistence-only branch hydration is not implemented. Mutations should use Tree.execute so the operation lifetime is protected. Existing shared-index catalogs are not migrated.

Raw results: [before](../standard-2026-11-26T23-41-05.463Z/size-10000-run-01.json), [updated](size-10000-run-01.json), [ten-organization smoke](../parallel-organizations-1000-2026-11-27T01-24-10.235Z/result.json).
