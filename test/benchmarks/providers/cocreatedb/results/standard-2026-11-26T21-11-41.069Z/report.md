# CoCreateDB standardized benchmark results

- Run ID: `2026-11-26T21-11-41.069Z`; executed: 2026-11-26T21:11:41.069Z to 2026-11-26T21:13:54.555Z.
- Source revision: `fc17a1171a7d51489aec493f9501031ff75e547e`; DB version 1.1.0. Measured with uncommitted working-tree changes.
- Public request path: DB.init -> db.send -> tree.execute. Internal instrumentation observes queue completion and telemetry only.
- Public API checks: {"thinDB":"passed","organizationTree":"passed","directTreeCRUD":"passed","timing":"direct Tree probes are outside operation latency and create/index measurements"}.
- Runtime: v24.18.0 / linux-x64; CPU: AMD EPYC 7571 (2 logical CPUs); RAM: 7838.21 MiB; limit: n/a.
- Method: 1 independent runs/size; 10 warmups and 40 samples per latency operation; 5000 ms sustained runs per workload/concurrency.
- Process model: single in-process Node process; benchmark client and database share CPU/RSS; mode: adaptive; acknowledgement: memory; memory policy: node-wide thresholds. local writes are queued after memory acknowledgement; disk drain excluded from request timings.
- No competitor databases, containers, dependencies or datasets were installed or launched.

Each run is a fresh child process and database. Fixture data is generated and hashed in 1,000-record batches. The create/index lifecycle timer spans batch generation, create acknowledgements, and the final index drain; fixture generation time and cumulative time awaiting create acknowledgements are reported separately, and background work can overlap those intervals. The fixture hash is over the canonical pre-ingestion JSON dataset. Correctness checks compare UUID result sets before query timings are accepted. Measured request latency stops before result assertions. Sustained modes are read-only, increment-only writes, or alternating read/write calls; concurrency means outstanding in-process requests, not parallel database threads.

Initialization and readiness are reported separately. Object create acknowledges before leaf finalization and index attachment; the standard runner drains this background work before beginning query measurements. The full create/index lifecycle includes the final drain. Local Warm writes are queued after memory acknowledgement; their disk drain is not included in request timings. External persistence is not configured. CPU and RSS include both the benchmark client and database in the same Node process. Incremental memory/object is an approximate loaded-minus-idle RSS ratio.

| Size | Runs passed | Fixture hash | Create + index ms | Create ops/s | Loaded RSS | Peak RSS |
| ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 100,000 | 1/1 | `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b` | 89345.240 | 1,119 ops/s | 729.63 MiB | 935.60 MiB |

## 100,000 objects

- Runs: 1/1 passed; fixture hash: `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b`.
- Init: 4.148 ms; readiness: 6.040 ms; first object create: 4.481 ms.
- Bulk create/index lifecycle: 89345.240 ms; 1,119 ops/s.
- Cumulative create acknowledgement wait: 8021.491 ms; fixture generation: 878.782 ms; final index drain wait: 80439.408 ms.
- Filtered bulk delete: 2.958 ms for 25 leaves.
- Total independent run time: 121389.428 ms.
- Index entries/object: 17; create acknowledgement returns before leaf/index finalization, which is drained before query measurements.
- Memory (idle / loaded / peak RSS): 61.07 MiB / 729.63 MiB / 935.60 MiB.
- Memory policy: {"stages":[25,50,75,90],"diskFirst":90,"hysteresis":2.5}; peak node usage: 45.282%.
- Incremental memory/object: 7010.386 bytes RSS; incremental heap: 501.88 MiB.
- CPU: 112672.153 ms user + 47145.184 ms system; 131.657% utilization.

| Operation | First ms | Warm min ms | Warm max ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| singleCreate | 1.226 | 0.228 | 0.560 | 0.309 | 0.282 | 0.467 | 0.560 | 3,205 ops/s |
| uuidRead | 0.276 | 0.024 | 0.188 | 0.046 | 0.040 | 0.093 | 0.188 | 13,147 ops/s |
| equality | 3.595 | 0.915 | 8.436 | 1.530 | 1.358 | 1.783 | 8.436 | 635 ops/s |
| nestedEquality | 6.449 | 4.063 | 6.611 | 4.823 | 4.581 | 6.048 | 6.611 | 206 ops/s |
| numericRange | 4.214 | 2.810 | 4.167 | 3.168 | 3.061 | 3.597 | 4.167 | 311 ops/s |
| and | 7.665 | 6.806 | 8.371 | 7.131 | 6.924 | 8.088 | 8.371 | 139 ops/s |
| or | 3.172 | 2.317 | 4.399 | 2.759 | 2.505 | 3.421 | 4.399 | 352 ops/s |
| singleKeyUpdate | 3.261 | 0.072 | 0.187 | 0.107 | 0.097 | 0.172 | 0.187 | 9,195 ops/s |
| indexedKeyUpdate | 0.378 | 0.073 | 0.178 | 0.098 | 0.081 | 0.152 | 0.178 | 10,087 ops/s |
| numericIncrement | 1.297 | 0.077 | 0.239 | 0.098 | 0.084 | 0.161 | 0.239 | 10,057 ops/s |
| singleDelete | 0.603 | 0.019 | 0.067 | 0.024 | 0.021 | 0.034 | 0.067 | 38,492 ops/s |

| Sustained mode | In-flight | ops/s | p50 ms | p95 ms | p99 ms | CPU utilization |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 81,834 ops/s | 0.009 | 0.015 | 0.034 | 105.259% |
| write | 1 | 16,335 ops/s | 0.048 | 0.090 | 0.144 | 110.031% |
| mixed | 1 | 28,153 ops/s | 0.043 | 0.070 | 0.103 | 102.703% |
| read | 8 | 111,272 ops/s | 0.058 | 0.088 | 0.162 | 100.238% |
| write | 8 | 24,827 ops/s | 0.290 | 0.406 | 0.561 | 101.784% |
| mixed | 8 | 38,150 ops/s | 0.170 | 0.241 | 0.321 | 101.206% |

| Run | Status | Failure / skip reason |
| ---: | --- | --- |
| - | all passed | - |

## Historical v2 lifecycle comparison

No v2 compatibility runs completed; this report contains only the selected standard benchmark baseline.

| v2 metric | Historical summary | Current compatibility median |
| --- | ---: | ---: |
| n/a | retained only in the historical provider summary | n/a |

## Raw results and failures

Raw independent runs and the manifest are stored under `/home/ubuntu/Dev/CoCreateJS/modules/db/test/benchmarks/providers/cocreatedb/results/standard-2026-11-26T21-11-41.069Z`. Status counts: {"successfulRuns":1,"failedRuns":0,"notAttempted":0}. The provider summary is recorded in [summary.json](../summary.json).

## Limits and follow-up

This report measures a single-node CoCreateDB run with adaptive memory residency and local Warm writes. MongoDB and Redis have separate provider adapters and reports; compare their results by operation while accounting for transport, indexing and durability differences. Distributed synchronization, replication, sharding, external persistence durability, server/client separation, and transaction guarantees are out of scope.
