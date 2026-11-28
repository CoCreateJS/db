# Current CoCreateDB benchmark results

One newest passing result is retained for each distinct workload. When the same organization count and records per organization were run more than once, the newest run replaces the earlier result. Workloads with the same total records but different organization/record distributions remain separate.

| Workload | Total records | Index-ready lifecycle | Throughput (records/s) | Host CPU average | Report |
| --- | ---: | ---: | ---: | ---: | --- |
| 1 organization, 80 arrays × 5,000 | 400,000 | 93.02 s | 4,300 | 18.80% across 8 logical CPUs | [Report](index-lifecycle-400000-80x5000-2026-11-27T17-18-53.547Z/report.md) |

This index-lifecycle diagnostic ends when acknowledgement is complete and the index queue reaches zero. Its report includes per-second CRUD acknowledgement and disk adapter I/O samples, plus the disk queue snapshot at that point; it deliberately does not wait for storage completion. The run used a dirty worktree; its base commit and tracked-diff hash are recorded with the result.

## Current worker-affinity workload

This workload uses the current local-per-worker runtime: one DB process and one pinned organization per worker. The test records bulk indexing readiness and then samples CRUD operations. It waits for index queues only; disk queues and adapter activity are captured separately without waiting for disk completion.

| Workload | Total records | Create + index | Bulk create throughput | Host CPU average | Aggregate worker RSS peak | Disk items at index-ready | Report |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 8 workers × 1 organization × 125,000 | 1,000,000 | 60.23 s | 16,620 records/s | 76.68% across 8 logical CPUs | 22,004 MiB | 1,520,878 | [Report](worker-affinity-1000000-8x-2026-11-27T21-53-34.604Z/report.md) |

The run passed all assignment and CRUD correctness checks. It also sampled create/read/indexed-read/update/delete throughput, host CPU and memory, per-worker RSS, and disk adapter operations. The complete queue and CRUD figures are in [raw JSON](worker-affinity-1000000-8x-2026-11-27T21-53-34.604Z/result.json). The disk queue count is a count of pending storage items; adapter I/O operation counts are reported separately.

| Workload | Total records | Create + index | Throughput (records/s) | Process RSS | Report |
| --- | ---: | ---: | ---: | ---: | --- |
| 40 organizations × 25,000, 8 workers | 1,000,000 | 584.28 s | 1,712 | 6,907 MiB summed sample after indexing | [Report](worker-organizations-1000000-40x25k-8-workers-2026-11-27T14-13-12/report.md) |
| 1 organization, 4 arrays × 2,500, 1 vs 2 workers | 10,000 | 6.09 / 6.23 s | 1,643 / 1,605 | 358.8 / 416.2 MiB sampled after indexing | [Report](worker-trees-10000-2026-11-27T06-00-14.380Z/README.md) |
| 1 organization, 40 arrays × 10,000, 2 workers | 400,000 | 239.86 s | 1,668 | 3,948 MiB sampled after indexing | [Report](worker-trees-400000-40-arrays-2026-11-27T13-30-28/report.md) |
| 1 organization, 40 arrays × 10,000, 4 workers | 400,000 | 230.78 s | 1,733 | 3,335 MiB sampled after indexing | [Report](worker-trees-400000-40-arrays-2026-11-27T13-30-28/report.md) |
| 10 × 1,000 | 10,000 | 5.95 s | 1,681 | 285.9 MiB | [Report](parallel-organizations-1000-2026-11-27T01-24-10.235Z/report.md) |
| 10,000, one organization | 10,000 | 8.77 s | 1,140 | 264.0 MiB | [Report](standard-2026-11-27T01-25-19.202Z/comparison.md) |
| 100,000, one organization | 100,000 | 89.35 s | 1,119 | 935.6 MiB | [Report](standard-2026-11-26T21-11-41.069Z/report.md) |
| 2 × 100,000 | 200,000 | 155.87 s | 1,283 | 1401.4 MiB | [Report](parallel-organizations-2x100k-2026-11-26T21-15-31.602Z/report.md) |
| 200,000, one organization | 200,000 | 204.96 s | 976 | 1552.0 MiB | [Report](standard-2026-11-26T18-22-05.815Z/report.md) |
| 3 × 100,000 | 300,000 | 200.43 s | 1,497 | 2478.3 MiB | [Report](parallel-organizations-3x100k-2026-11-27T02-28-23.492Z/report.md) |
| 1 × 400,000 | 400,000 | 392.20 s | 1,020 | 2163.0 MiB | [Report](single-organization-400k-2026-11-27T02-35-21.844Z/report.md) |
| 20 primary trees, one organization × 20,000 | 400,000 | 232.31 s | 1,722 | 2146.9 MiB | [Report](primary-trees-1org-20x20k-2026-11-27T04-25-57.624Z/report.md) |
| 16 × 25,000 | 400,000 | 231.57 s | 1,727 | 2852.9 MiB | [Report](parallel-organizations-16x25k-2026-11-27T02-53-13.516Z/report.md) |
| 4 × 100,000 | 400,000 | 262.44 s | 1,524 | 2750.4 MiB | [Report](parallel-organizations-4x100k-2026-11-27T02-11-27.956Z/report.md) |
| 40 × 10,000 | 400,000 | 232.58 s | 1,720 | 3100.2 MiB | [Report](parallel-organizations-40x10k-2026-11-27T04-02-03.670Z/report.md) |
| 8 × 50,000 | 400,000 | 239.81 s | 1,668 | 3000.5 MiB | [Report](parallel-organizations-8x50k-2026-11-27T02-47-01.100Z/report.md) |
| 5 × 100,000 | 500,000 | 339.01 s | 1,475 | 3125.0 MiB | [Report](parallel-organizations-5x100k-2026-11-27T02-18-07.582Z/report.md) |
| 8 × 100,000 | 800,000 | 670.57 s | 1,193 | 4152.3 MiB | [Report](parallel-organizations-8x100k-2026-11-26T21-58-36.676Z/report.md) |
| 10 × 100,000 | 1,000,000 | 927.76 s | 1,078 | 5422.9 MiB | [Report](parallel-organizations-10x100k-2026-11-27T01-30-11.568Z/report.md) |
| Natural-pruning workload: 40 primary trees × 25,000 | 1,000,000 | 831.91 s | 1,202 | 4877.1 MiB | [Report](primary-pruning-2026-11-27T04-51-37.070Z/report.md) |


The 20-primary-tree benchmark uses a custom configuration with 20 top-level roots, exactly one live Tree per root, and one organization. Its pre-query index drain reached zero. The update-isolation check afterward left one queued index update; that follow-up queue was outside create-and-index timing.


## Partial backlog runs

- 2,000,000 planned creates, one organization, 80 arrays × 25,000, index-lifecycle diagnostic: stopped after about 2m24s before index readiness. Exact create acknowledgements and adapter ops/sec were not captured because the original harness only wrote its report at the end. The remaining temporary directory showed 33 finalized files and 17 staged temp files after termination; these are not a trustworthy throughput measure. [Partial report](index-lifecycle-2000000-80x25000-2026-11-27T17-36-21.871Z/partial-report.md) and [partial snapshot](index-lifecycle-2000000-80x25000-2026-11-27T17-36-21.871Z/partial-result.json).
- 2,000,000 records, one organization, 80 primary Trees × 25,000, current worktree: all records acknowledged and `pendingIndexCount` reached zero; stopped during disk drain with 918,564 pending/in-flight disk items. [Partial report](primary-pruning-2000000-80x25k-heap23g-2026-11-27T16-21-58Z/partial-report.md) and [raw snapshot](primary-pruning-2000000-80x25k-heap23g-2026-11-27T16-21-58Z/partial-result.json).
- Same workload with the default Node heap failed at 700,000 acknowledged records with V8 heap exhaustion. [Partial report](primary-pruning-2000000-80x25k-2026-11-27T16-20-00Z/partial-report.md).

The primary-tree pruning diagnostic uses one organization and 40 independently configured top-level primary Trees. It holds 15 early trees idle and directs later writes to the remaining 25; the full million-record load reached natural pruning at the node-memory watermark. The parallel-organization diagnostics use one Node process, concurrent organization Trees, and separate organization directories. Their per-organization timings overlap and must not be summed. They measure create plus index drain, include telemetry and local disk writes, and do not include the standard sustained workload. The 10K standard comparison is a single run on each side; see its report for the comparison limits. These are single-host diagnostics, not multi-node cluster benchmarks. Raw results and run manifests are stored alongside each report.

The primary-orchestrated worker-tree benchmark uses one organization, 40 arrays, 400,000 records, and either two or four real Node worker processes over the existing Cluster IPC transport. The primary distributes array ownership round-robin; each worker owns 20 arrays with two workers or 10 arrays with four. Both runs use the same deterministic fixture. The benchmark reports create acknowledgements separately from create-plus-index completion. Process RSS is sampled after indexing and is not a peak measurement. These are single samples, not a scaling claim; see the run report and raw JSON for details.

The latest 40 × 10K pass was run against the uncommitted worktree based on 1a6cfda. Its captured worktree state is in [run context](parallel-organizations-40x10k-2026-11-27T04-02-03.670Z/run-context.json).

The [disk coalescing investigation](disk-coalescing-2026-11-27T23-35-55.911Z/report.md) distinguishes submitted requests/bytes from actual filesystem writes. Earlier worker-affinity `bytesWritten` and operation counters were measured before adapter coalescing and do not represent physical EBS traffic. Historical result files are preserved.

The attached 400K run has a [label review](worker-affinity-400000-8x-2026-11-28T00-12-25.784Z/label-review.md) explaining submitted versus completed file writes. New worker-affinity reports use separate adapter-request and filesystem tables; original raw data is preserved.
