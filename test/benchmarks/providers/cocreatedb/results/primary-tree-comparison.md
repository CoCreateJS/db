# Independent primary Trees: 10K comparison

The checkpoint is `1a6cfda` on `dev`. The refactor is uncommitted. Both use one
organization, the standard 10,000-record fixture v3, Node v24.18.0, index size 64,
memory acknowledgement, local Disk and no external Persistence. Full runs completed
all correctness and public API assertions. No 100K or million-record result is
claimed for this refactor.

Fixture SHA-256:
`767927150f41a6967e99ab0e05f11128ba4f408f1b9bfc5e1fc753a84119ac8f`.

| Measurement | Checkpoint run 1 | Checkpoint run 2 | Final refactor |
| --- | ---: | ---: | ---: |
| Create acknowledgement, 10K batch total | 1.059 s | 1.062 s | 1.050 s |
| Final index drain | 7.106 s | 7.276 s | 9.607 s |
| Create and index, including fixture generation | 8.275 s | 8.448 s | 10.764 s |
| UUID read p50 | 0.0690 ms | 0.0647 ms | 0.0678 ms |
| Equality read p50 | 1.7152 ms | 1.9279 ms | 1.6439 ms |
| Range read p50 | 1.4630 ms | 1.4621 ms | 1.4031 ms |
| AND read p50 | 2.9135 ms | 2.7264 ms | 2.5718 ms |
| OR read p50 | 1.6777 ms | 1.4580 ms | 1.6042 ms |
| Single-key update p50 | 0.1118 ms | 0.1271 ms | 0.1331 ms |
| Peak sampled/process RSS | 297.8 MiB | 290.2 MiB | 288.5 MiB |

Acknowledgement remains similar. The final full lifecycle is about 28.7% slower
than the mean of the two checkpoint runs; its drain is about 33.6% slower. This is
an unresolved regression, not a demonstrated performance improvement. The two
earlier intermediate implementations also drained more slowly (8.983 s and
9.297 s), so the full-harness result should not be dismissed as one outlier.
Query samples are small and do not establish a stable speed improvement.

The architectural change removes per-leaf membership tracking and subtree walks
from pruning. Selecting the lowest-weight engine scans resident candidates;
removing the selected owner is a direct Map deletion. Tests verify that active
reads, pending storage and queued updates prevent removal, that neighbors and
nested Trees stay independent, and that cold reads restore only required paths
and payloads. Actual memory reclamation still depends on GC and application-held
references. The standard run did not reach the 75% node-memory pruning watermark,
so it does not measure pruning throughput under pressure.

## Raw full-harness reports

- Checkpoint run 1: [03:36 report](standard-2026-11-27T03-36-36.055Z/size-10000-run-01.json).
- Checkpoint run 2: [03:53 report](standard-2026-11-27T03-53-17.208Z/size-10000-run-01.json).
- Intermediate refactor: [03:45 report](standard-2026-11-27T03-45-55.977Z/size-10000-run-01.json).
- Intermediate refactor: [03:49 report](standard-2026-11-27T03-49-35.292Z/size-10000-run-01.json).
- Final refactor: [03:57 report](standard-2026-11-27T03-57-58.613Z/size-10000-run-01.json).

## Focused create profile

`diagnostics/primary-create.mjs` loads either checkout and instruments leaf writes,
index insertion and branch writes. It inserts the same 10K records in 1,000-item
chunks, but omits the full harness's readiness/seed, hashing and later workloads.
It is a separate workload, not a substitute for the standard comparison.

This diagnostic measured 7.781 s before and 7.751 s after, with acknowledgement
at 1.248 s and 1.252 s. Branch writes were 7,036 and 7,038; leaf writes were 10,003
in both. Stage durations overlap across independent Trees and concurrent I/O, so
they must not be added as a wall-clock breakdown. These observations do not yet
explain the full-harness regression. The next investigation should trace batching
and write scheduling with the standard readiness/seed sequence retained.

Raw profiles: [before](primary-tree-profiles/before.json),
[after](primary-tree-profiles/after.json).

## Compatibility

The new storage configuration separates organization routing from per-primary
index catalogs. No compatibility reader or migration was added for historical
organization-wide catalogs. Benchmark directories were fresh. The refactor remains
uncommitted for review and further optimization against the checkpoint.
