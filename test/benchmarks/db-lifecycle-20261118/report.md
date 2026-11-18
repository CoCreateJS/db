# Indexing investigation

Measured on Node `v24.18.0`, Linux x64, 2 available CPUs, `memoryOnly: true`.
The 1,000-document complex workload and its percentile timings are recorded in
[`results/run-2026-11-18T22-52-42.388Z.json`](results/run-2026-11-18T22-52-42.388Z.json).

## What was happening

The flat index reused each field's catalog, but its write path still rewrote
that catalog after every inserted value. A 1,000-document flush also updated
the containing array and database counts once per document. Those metadata
updates reindexed the same count fields repeatedly. Both costs grew with the
number of records even when the schema and field catalogs were already present.

## Changes and measurements

The indexing flush now batches catalog pointer/stat updates and `_id` catalog
length changes until the queued index work completes. Create batches also
aggregate their array/database object-count changes and apply those once. The
existing index nodes and records are still mutated in place; value entries are
still inserted for each document.

| 1,000 documents | Before | After |
| --------------: | -----: | ----: |
| Complex workload index flush | 28.00 s | 8.22 s |
| UUID read p50 | 0.27 ms | 0.29 ms |
| Nested equality read p50 | 2.19 ms | 2.21 ms |
| Range read p50 | 8.41 ms | 8.15 ms |

The index flush fell about **71%**. A separate repeated-field benchmark adds two
1,000-document batches with the same three fields (18 indexed entries per
document). After the change, the first flush took **1.48 s** and the second
took **1.27 s**, showing that the existing catalogs are reused. Raw results:
[`results/reuse-2026-11-18T22-51-47.758Z.json`](results/reuse-2026-11-18T22-51-47.758Z.json).

The benchmark checks result counts for UUID, equality, nested, and range reads,
then confirms deleted UUIDs no longer resolve. The remaining 8.22 seconds is
still a meaningful indexing cost for this workload. Leaf insertion, value
digests for nested objects/arrays, and index partition writes are the next
places to profile. These results are memory-only and do not measure durable
disk or peer/persistence traffic; each index-flush value is one run.
