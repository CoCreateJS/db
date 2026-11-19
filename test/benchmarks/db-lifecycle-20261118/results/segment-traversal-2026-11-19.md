# CoCreateDB segment traversal optimization — 2026-11-19

Compared clean baseline `1b5d178` (40 samples) against the final code (100 samples) on Node v24.18.0, Linux x64, 1,000 documents, memory-only mode, and the same lifecycle workload. Each timed run was repeated in one process; the final run reported below had 124% CPU utilization on a 2-vCPU host and 116,536 KiB peak RSS. The baseline reported 123% CPU and 116,200 KiB peak RSS. RSS varied across final repetitions (116,536 and 132,424 KiB); the higher reading appears to be process/GC variance, so memory is effectively unchanged rather than a claimed reduction.

## Baseline and final

| Operation | Baseline | Final | Change |
| --- | ---: | ---: | ---: |
| Index flush | 3,123.75 ms | 2,615.82 ms | -16.3% |
| UUID read p50 | 0.171 ms | 0.094 ms | -45.3% |
| Equality read p50 | 2.852 ms | 1.589 ms | -44.3% |
| Nested-path read p50 | 1.758 ms | 0.967 ms | -45.0% |
| Range read p50 | 6.619 ms | 4.259 ms | -35.7% |
| UUID update p50 | 0.445 ms | 0.303 ms | -32.0% |
| Delete 25 records | 6.97 ms | 6.28 ms | -9.8% |
| Peak RSS | 116,200 KiB | 116,536 KiB | +0.3% |

The final run also recorded p95/p99 latency per operation in `final-timed-2026-11-19.json`. Sample counts differ (40 baseline, 100 final), so treat percentile comparisons as directional. Dataset, Node version, benchmark, and runtime mode were held constant.

## Isolated hierarchy-search comparison

A 100-sample run with only internal-node seeking changed back to linear sibling scans measured 2,803.54 ms flush, 1.533 ms equality p50, and 4.204 ms range p50. The binary-search run measured 2,854.32 ms, 1.591 ms, and 4.376 ms respectively. This shallow 1,000-document workload does not demonstrate a binary-search win; the differences are small and likely sensitive to runtime noise. Binary seeking remains in place to meet logarithmic traversal at every ordered segment level and should be remeasured on deeper catalogs and larger datasets.

## Implementation and correctness

- Segment references now store direct `uuid`, `length`, `firstValue`, `firstUuid`, `lastValue`, and `lastUuid` fields. Value and UUID boundaries are carried through leaf, internal, and catalog levels.
- The organization owns one resident UUID-to-artifact Map shared by scope indexes and document artifacts; known UUIDs go directly to live references.
- Internal and leaf traversal use ordered bounds; query tie ordering and duplicate semantics are retained.
- Removed legacy nested-format and length compatibility handling. Index partitions are addressed by UUID, and mutation-side database/array routing and batch catalog lookups no longer stringify temporary compound keys.
- Nine focused tests passed, covering split/reopen/pruning, flattened catalog metadata, UUID Map/live references, equality/range ordering, duplicate ties, reverse/open-bound scans, dotted-path filters, and persistence reopen.
- Broader affected-file run: 32/69 passed, 37 failed. Many failures assert older CRUD and filesystem contracts; this run is not green and those failures were not independently established as pre-existing. They need a separate compatibility/fixture review before merge.

## Run artifacts

- Baseline raw run: `run-2026-11-19T01-53-38.853Z.json`
- Baseline timed summary: `baseline-timed-2026-11-19.json`
- Final raw run: `run-2026-11-19T02-32-54.337Z.json`
- Final timed summary: `final-timed-2026-11-19.json`
- Linear-scan experiment: 100-sample run at `02:28:43Z` in a temporary worktree
