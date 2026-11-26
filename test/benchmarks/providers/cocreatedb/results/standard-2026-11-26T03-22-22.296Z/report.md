# CoCreateDB standardized benchmark results

- Run ID: `2026-11-26T03-22-22.296Z`; executed: 2026-11-26T03:22:22.296Z to 2026-11-26T03:25:54.571Z.
- Source revision: `5ff628a817fa89a00d042a752e9d683d21b6409d`; DB version 1.1.0.
- Runtime: v24.18.0 / linux-x64; CPU: AMD EPYC 7571 (2 logical CPUs); RAM: 7838.21 MiB; limit: n/a.
- Method: 3 independent runs/size; 10 warmups and 40 samples per latency operation; 1000 ms sustained runs per workload/concurrency.
- Process model: single in-process Node process; benchmark client and database share CPU/RSS; mode: adaptive; acknowledgement: memory; memory allocation: 25%. local writes are queued after memory acknowledgement; disk drain excluded from request timings.
- No competitor databases, containers, dependencies or datasets were installed or launched.

Each run is a fresh child process and database. Fixture data is generated and hashed in 1,000-record batches. The create/index lifecycle timer spans batch generation, create acknowledgements, and the final index drain; fixture generation time and cumulative time awaiting create acknowledgements are reported separately, and background work can overlap those intervals. The fixture hash is over the canonical pre-ingestion JSON dataset. Correctness checks compare UUID result sets before query timings are accepted. Measured request latency stops before result assertions. Sustained modes are read-only, increment-only writes, or alternating read/write calls; concurrency means outstanding in-process requests, not parallel database threads.

Initialization and readiness are reported separately. Object create acknowledges before leaf finalization and index attachment; the standard runner drains this background work before beginning query measurements. The full create/index lifecycle includes the final drain. Local Warm writes are queued after memory acknowledgement; their disk drain is not included in request timings. External persistence is not configured. CPU and RSS include both the benchmark client and database in the same Node process. Incremental memory/object is an approximate loaded-minus-idle RSS ratio.

| Size | Runs passed | Fixture hash | Create + index ms | Create ops/s | Loaded RSS | Peak RSS |
| ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 100,000 | 3/3 | `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b` | 43611.454 | 2,293 ops/s | 750.45 MiB | 798.79 MiB |

## 100,000 objects

- Runs: 3/3 passed; fixture hash: `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b`.
- Init: 3.516 ms; readiness: 5.461 ms; first object create: 4.470 ms.
- Bulk create/index lifecycle: 43611.454 ms; 2,293 ops/s.
- Cumulative create acknowledgement wait: 6975.028 ms; fixture generation: 879.301 ms; final index drain wait: 35351.491 ms.
- Filtered bulk delete: 3.032 ms for 25 leaves.
- Total independent run time: 48654.568 ms.
- Index entries/object: 17; create acknowledgement returns before leaf/index finalization, which is drained before query measurements.
- Memory (idle / loaded / peak RSS): 60.82 MiB / 750.45 MiB / 798.79 MiB.
- Memory allocation: 25% of system memory; requested / effective budget: 1959.55 MiB / 1959.55 MiB.
- Incremental memory/object: 7230.996 bytes RSS; incremental heap: 593.84 MiB.
- CPU: 42447.541 ms user + 23449.656 ms system; 136.393% utilization.

| Operation | First ms | Warm min ms | Warm max ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| singleCreate | 132.596 | 0.367 | 1.840 | 0.756 | 0.629 | 1.365 | 1.840 | 1,319 ops/s |
| uuidRead | 0.315 | 0.028 | 0.201 | 0.049 | 0.044 | 0.076 | 0.201 | 19,391 ops/s |
| equality | 2.596 | 0.980 | 25.240 | 1.923 | 1.305 | 1.671 | 25.240 | 510 ops/s |
| nestedEquality | 5.994 | 3.876 | 9.212 | 4.628 | 4.207 | 6.008 | 9.212 | 214 ops/s |
| numericRange | 4.509 | 2.956 | 4.325 | 3.266 | 3.164 | 3.613 | 4.325 | 303 ops/s |
| and | 8.152 | 7.113 | 9.236 | 7.449 | 7.249 | 8.274 | 9.236 | 134 ops/s |
| or | 3.390 | 2.558 | 3.674 | 2.821 | 2.727 | 3.460 | 3.674 | 345 ops/s |
| singleKeyUpdate | 3.399 | 0.076 | 0.177 | 0.110 | 0.104 | 0.168 | 0.177 | 8,976 ops/s |
| indexedKeyUpdate | 0.401 | 0.078 | 0.203 | 0.103 | 0.083 | 0.167 | 0.203 | 9,518 ops/s |
| numericIncrement | 1.447 | 0.081 | 0.167 | 0.107 | 0.092 | 0.164 | 0.167 | 9,158 ops/s |
| singleDelete | 0.598 | 0.026 | 0.067 | 0.034 | 0.032 | 0.046 | 0.067 | 26,314 ops/s |

| Sustained mode | In-flight | ops/s | p50 ms | p95 ms | p99 ms | CPU utilization |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 65,717 ops/s | 0.011 | 0.019 | 0.036 | 128.457% |
| write | 1 | 15,173 ops/s | 0.053 | 0.094 | 0.131 | 127.274% |
| mixed | 1 | 29,112 ops/s | 0.042 | 0.066 | 0.089 | 110.678% |

| Run | Status | Failure / skip reason |
| ---: | --- | --- |
| - | all passed | - |

## Historical v2 lifecycle comparison

No v2 compatibility runs completed; this report contains only the selected standard benchmark baseline.

| v2 metric | Historical summary | Current compatibility median |
| --- | ---: | ---: |
| n/a | retained only in the historical provider summary | n/a |

## Raw results and failures

Raw independent runs and the manifest are stored under `/home/ubuntu/Dev/CoCreateJS/modules/db/test/benchmarks/providers/cocreatedb/results/standard-2026-11-26T03-22-22.296Z`. Status counts: {"successfulRuns":3,"failedRuns":0,"notAttempted":0}. The provider summary is recorded in [summary.json](../summary.json).

## Limits and follow-up

This report measures a single-node CoCreateDB run with adaptive memory residency and local Warm writes. MongoDB and Redis have separate provider adapters and reports; compare their results by operation while accounting for transport, indexing and durability differences. Distributed synchronization, replication, sharding, external persistence durability, server/client separation, and transaction guarantees are out of scope.
