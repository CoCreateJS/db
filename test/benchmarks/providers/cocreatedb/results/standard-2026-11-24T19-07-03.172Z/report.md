# CoCreateDB standardized benchmark results

- Run ID: `2026-11-24T19-07-03.172Z`; executed: 2026-11-24T19:07:03.172Z to 2026-11-24T19:23:17.760Z.
- Source revision: `9851ef3f258455952c517eafb2adf9e458d299d5`; DB version 1.1.0.
- Runtime: v24.18.0 / linux-x64; CPU: AMD EPYC 7571 (2 logical CPUs); RAM: 7838.21 MiB; limit: n/a.
- Method: 5 independent runs/size; 10 warmups and 40 samples per latency operation; 5000 ms sustained runs per workload/concurrency.
- Process model: single in-process Node process; benchmark client and database share CPU/RSS; mode: adaptive; acknowledgement: memory; memory allocation: 25%. local writes are queued after memory acknowledgement; disk drain excluded from request timings.
- No competitor databases, containers, dependencies or datasets were installed or launched.

Each run is a fresh child process and database. Fixture data is generated and hashed in 1,000-record batches. The create/index lifecycle timer spans batch generation, create acknowledgements, and the final index drain; fixture generation time and cumulative time awaiting create acknowledgements are reported separately, and background work can overlap those intervals. The fixture hash is over the canonical pre-ingestion JSON dataset. Correctness checks compare UUID result sets before query timings are accepted. Measured request latency stops before result assertions. Sustained modes are read-only, increment-only writes, or alternating read/write calls; concurrency means outstanding in-process requests, not parallel database threads.

Initialization and readiness are reported separately. Object create acknowledges before leaf finalization and index attachment; the standard runner drains this background work before beginning query measurements. The full create/index lifecycle includes the final drain. Local Warm writes are queued after memory acknowledgement; their disk drain is not included in request timings. External persistence is not configured. CPU and RSS include both the benchmark client and database in the same Node process. Incremental memory/object is an approximate loaded-minus-idle RSS ratio.

| Size | Runs passed | Fixture hash | Create + index ms | Create ops/s | Loaded RSS | Peak RSS |
| ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 100,000 | 5/5 | `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b` | 75750.633 | 1,320 ops/s | 733.59 MiB | 898.68 MiB |

## 100,000 objects

- Runs: 5/5 passed; fixture hash: `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b`.
- Init: 6.692 ms; readiness: 2.304 ms; first object create: 1.520 ms.
- Bulk create/index lifecycle: 75750.633 ms; 1,320 ops/s.
- Cumulative create acknowledgement wait: 74459.114 ms; fixture generation: 845.115 ms; final index drain wait: 511.236 ms.
- Filtered bulk delete: 174.657 ms for 25 leaves.
- Total independent run time: 107413.688 ms.
- Index entries/object: 17; create acknowledgement returns before leaf/index finalization, which is drained before query measurements.
- Memory (idle / loaded / peak RSS): 63.23 MiB / 733.59 MiB / 898.68 MiB.
- Memory allocation: 25% of system memory; requested / effective budget: n/a / n/a.
- Incremental memory/object: 7026.852 bytes RSS; incremental heap: 531.15 MiB.
- CPU: 103352.266 ms user + 21505.378 ms system; 115.930% utilization.

| Operation | First ms | Warm min ms | Warm max ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| singleCreate | 1.325 | 1.022 | 2.619 | 1.523 | 1.461 | 2.026 | 2.619 | 653 ops/s |
| uuidRead | 0.310 | 0.031 | 0.129 | 0.064 | 0.065 | 0.109 | 0.129 | 13,863 ops/s |
| equality | 1.562 | 0.677 | 1.164 | 0.884 | 0.875 | 1.065 | 1.164 | 1,090 ops/s |
| nestedEquality | 1.211 | 0.651 | 5.863 | 1.142 | 0.946 | 1.584 | 5.863 | 853 ops/s |
| numericRange | 1.240 | 0.629 | 1.338 | 0.917 | 0.877 | 1.019 | 1.338 | 1,066 ops/s |
| and | 7.045 | 4.744 | 6.759 | 5.314 | 5.065 | 6.340 | 6.759 | 187 ops/s |
| or | 3.328 | 2.314 | 3.903 | 2.742 | 2.669 | 3.359 | 3.903 | 361 ops/s |
| singleKeyUpdate | 3.682 | 0.246 | 1.547 | 0.375 | 0.347 | 0.494 | 1.547 | 2,650 ops/s |
| indexedKeyUpdate | 1.984 | 0.304 | 0.669 | 0.414 | 0.369 | 0.588 | 0.669 | 2,400 ops/s |
| numericIncrement | 1.974 | 0.294 | 0.559 | 0.375 | 0.351 | 0.483 | 0.559 | 2,641 ops/s |
| singleDelete | 44.370 | 0.606 | 1.511 | 0.792 | 0.744 | 1.194 | 1.511 | 1,255 ops/s |

| Sustained mode | In-flight | ops/s | p50 ms | p95 ms | p99 ms | CPU utilization |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 44,760 ops/s | 0.018 | 0.032 | 0.055 | 105.495% |
| write | 1 | 3,530 ops/s | 0.247 | 0.364 | 0.478 | 112.181% |
| mixed | 1 | 6,829 ops/s | 0.211 | 0.304 | 0.402 | 103.234% |
| read | 8 | 54,016 ops/s | 0.083 | 0.155 | 0.254 | 100.220% |
| write | 8 | 3,900 ops/s | 1.127 | 2.042 | 2.686 | 102.229% |
| mixed | 8 | 7,109 ops/s | 0.535 | 1.090 | 1.460 | 102.145% |

| Run | Status | Failure / skip reason |
| ---: | --- | --- |
| - | all passed | - |

## Historical v2 lifecycle comparison

No v2 compatibility runs completed; historical results remain preserved in `providers/cocreatedb/results/summary.json` and `baselines/2026-11-19-final`.

| v2 metric | Historical summary | Current compatibility median |
| --- | ---: | ---: |
| n/a | retained only in the historical provider summary | n/a |

## Raw results and failures

Raw independent runs and the manifest are stored under `/home/ubuntu/Dev/CoCreateJS/modules/db/test/benchmarks/providers/cocreatedb/results/standard-2026-11-24T19-07-03.172Z`. Status counts: {"successfulRuns":5,"failedRuns":0,"notAttempted":0}. Provider summary appended to [summary.json](../summary.json) without replacing historical data.

## Limits and follow-up

This report measures a single-node CoCreateDB run with adaptive memory residency and local Warm writes. MongoDB and Redis have separate provider adapters and reports; compare their results by operation while accounting for transport, indexing and durability differences. Distributed synchronization, replication, sharding, external persistence durability, server/client separation, and transaction guarantees are out of scope.
