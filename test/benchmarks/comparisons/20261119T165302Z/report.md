# CoCreateDB lifecycle comparison

- Fixture: deterministic lifecycle v1, 1,000 records
- SHA-256: `fbd959942739226280b7dc574de2da9df89f9879b48e88f5b933add8a5a5d997`
- Runtime: v24.18.0 on linux-x64; 2 CPUs reported
- Samples: 40; warm percentiles follow 10 warmup operations
- Old source: `dev eb6f63fdbfd29a85bf64f2156ad3c52f77269d35`; new source: this branch’s prototype.
- Raw results: [old](old/run-2026-11-19T16-53-03.300Z.json), [Next](next/run-2026-11-19T16-53-06.685Z.json).

| Metric | Old | Next |
| --- | ---: | ---: |
| Index entries per record | 30 | 8 |
| Create + index, whole batch | 2608.160 ms | 170.629 ms |
| Created records per second | 383 ops/s | 5,861 ops/s |
| First UUID read after create | 0.140 ms | 0.029 ms |
| First UUID update after create | 0.462 ms | 0.149 ms |
| Cold UUID read after dataset build | 0.925 ms | 0.448 ms |
| Warm UUID read p50 / throughput | 0.118 ms / 8,074 ops/s | 0.011 ms / 61,534 ops/s |
| Warm equality p50 / throughput | 1.359 ms / 677 ops/s | 0.184 ms / 5,183 ops/s |
| Warm nested p50 / throughput | 0.854 ms / 1,043 ops/s | 0.135 ms / 6,216 ops/s |
| Warm range p50 / throughput | 4.189 ms / 219 ops/s | 0.306 ms / 2,885 ops/s |
| Warm UUID update p50 / throughput | 0.364 ms / 2,603 ops/s | 0.120 ms / 7,337 ops/s |
| Delete batch throughput | 202 ops/s | 17,444 ops/s |
| CPU user + system | 4070.4 + 119.3 ms | 312.0 + 14.9 ms |
| RSS after workload | 110.39 MiB | 73.07 MiB |
| Heap used after workload | 23.71 MiB | 11.24 MiB |

## Reading the comparison

Both runs use the same serialized fixture and query predicates. The tested UUID, equality, nested-path, and range reads each assert their expected result count. First-read/update timings are captured immediately after creating one additional object; warm timings include a cold sample, 10 warmups, and the configured measured samples.

The indexed-entry counts differ (old 30, Next 8 per record). The old engine indexes extra existence/container paths; Next currently indexes the scalar flattened leaves used by these queries. The create-and-index time is therefore a useful end-to-end prototype comparison, but not an equal-work indexing benchmark. Keep the coverage count beside throughput when evaluating future changes.

Old create-and-index combines request acknowledgment and the old engine’s index flush. Next indexes synchronously during create, so its create duration is the complete create-and-index duration. Delete throughput includes the old index flush and has no separate flush in Next. Disk durability, peer distribution, and external persistence are excluded from both runs.

CPU and memory are process-level readings after the workload; they include runtime overhead and are sensitive to host load and garbage collection. Repeat the comparison on an idle host before treating small differences as stable.
