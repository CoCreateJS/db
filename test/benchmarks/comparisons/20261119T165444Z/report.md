# CoCreateDB lifecycle comparison

- Fixture: deterministic lifecycle v2, 1,000 records
- SHA-256: `25ebce8889cb93e29279301a3681ce66ebe80d5cb0d147387455ad5cddb44e48`
- Runtime: v24.18.0 on linux-x64; 2 CPUs reported
- Samples: 40; warm percentiles follow 10 warmup operations
- Old source: `dev eb6f63fdbfd29a85bf64f2156ad3c52f77269d35`; new source: this branch’s prototype.
- Raw results: [old](old/run-2026-11-19T16-54-44.340Z.json), [Next](next/run-2026-11-19T16-54-47.777Z.json).

| Metric | Old | Next |
| --- | ---: | ---: |
| Index entries per record | 30 | 9 |
| Create + index, whole batch | 2611.973 ms | 180.956 ms |
| Created records per second | 383 ops/s | 5,526 ops/s |
| First UUID read after create | 0.117 ms | 0.032 ms |
| First UUID update after create | 0.370 ms | 0.159 ms |
| Cold UUID read after dataset build | 0.916 ms | 0.455 ms |
| Warm UUID read p50 / throughput | 0.128 ms / 7,131 ops/s | 0.011 ms / 58,733 ops/s |
| Warm equality p50 / throughput | 1.358 ms / 666 ops/s | 0.176 ms / 5,358 ops/s |
| Warm nested p50 / throughput | 0.829 ms / 1,043 ops/s | 0.136 ms / 6,343 ops/s |
| Warm range p50 / throughput | 5.278 ms / 180 ops/s | 0.313 ms / 3,048 ops/s |
| Warm UUID update p50 / throughput | 0.365 ms / 2,480 ops/s | 0.094 ms / 8,581 ops/s |
| Delete batch throughput | 199 ops/s | 15,428 ops/s |
| CPU user + system | 4114.3 + 153.6 ms | 308.1 + 19.6 ms |
| RSS after workload | 110.63 MiB | 72.91 MiB |
| Heap used after workload | 32.24 MiB | 10.56 MiB |

## Reading the comparison

Both runs use the same serialized fixture and query predicates. The tested UUID, equality, nested-path, and range reads each assert their expected result count. First-read/update timings are captured immediately after creating one additional object; warm timings include a cold sample, 10 warmups, and the configured measured samples.

The indexed-entry counts differ (old 30, Next 9 per record). The old engine indexes extra existence/container paths; Next currently indexes the scalar flattened leaves used by these queries. The create-and-index time is therefore a useful end-to-end prototype comparison, but not an equal-work indexing benchmark. Keep the coverage count beside throughput when evaluating future changes.

Old create-and-index combines request acknowledgment and the old engine’s index flush. Next indexes synchronously during create, so its create duration is the complete create-and-index duration. Delete throughput includes the old index flush and has no separate flush in Next. Disk durability, peer distribution, and external persistence are excluded from both runs.

CPU and memory are process-level readings after the workload; they include runtime overhead and are sensitive to host load and garbage collection. Repeat the comparison on an idle host before treating small differences as stable.
