# CoCreateDB standardized benchmark results

- Run ID: `2026-11-26T18-22-05.815Z`; executed: 2026-11-26T18:22:05.815Z to 2026-11-26T18:26:36.140Z.
- Source revision: `febb049d5068ff338436dd55acf39411d272a62c`; DB version 1.1.0.
- Runtime: v24.18.0 / linux-x64; CPU: AMD EPYC 7571 (2 logical CPUs); RAM: 7838.21 MiB; limit: n/a.
- Method: 1 independent runs/size; 10 warmups and 40 samples per latency operation; 5000 ms sustained runs per workload/concurrency.
- Process model: single in-process Node process; benchmark client and database share CPU/RSS; mode: adaptive; acknowledgement: memory; memory allocation: 25%. local writes are queued after memory acknowledgement; disk drain excluded from request timings.
- No competitor databases, containers, dependencies or datasets were installed or launched.

Each run is a fresh child process and database. Fixture data is generated and hashed in 1,000-record batches. The create/index lifecycle timer spans batch generation, create acknowledgements, and the final index drain; fixture generation time and cumulative time awaiting create acknowledgements are reported separately, and background work can overlap those intervals. The fixture hash is over the canonical pre-ingestion JSON dataset. Correctness checks compare UUID result sets before query timings are accepted. Measured request latency stops before result assertions. Sustained modes are read-only, increment-only writes, or alternating read/write calls; concurrency means outstanding in-process requests, not parallel database threads.

Initialization and readiness are reported separately. Object create acknowledges before leaf finalization and index attachment; the standard runner drains this background work before beginning query measurements. The full create/index lifecycle includes the final drain. Local Warm writes are queued after memory acknowledgement; their disk drain is not included in request timings. External persistence is not configured. CPU and RSS include both the benchmark client and database in the same Node process. Incremental memory/object is an approximate loaded-minus-idle RSS ratio.

| Size | Runs passed | Fixture hash | Create + index ms | Create ops/s | Loaded RSS | Peak RSS |
| ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 200,000 | 1/1 | `9227e45e1e6bab068070a34cba47d6388d91ec08bb02ef1407230deb262d788c` | 204956.518 | 976 ops/s | 1401.78 MiB | 1552.00 MiB |

## 200,000 objects

- Runs: 1/1 passed; fixture hash: `9227e45e1e6bab068070a34cba47d6388d91ec08bb02ef1407230deb262d788c`.
- Init: 2.823 ms; readiness: 5.514 ms; first object create: 4.620 ms.
- Bulk create/index lifecycle: 204956.518 ms; 976 ops/s.
- Cumulative create acknowledgement wait: 15776.903 ms; fixture generation: 1796.996 ms; final index drain wait: 187372.921 ms.
- Filtered bulk delete: 10.481 ms for 25 leaves.
- Total independent run time: 246465.258 ms.
- Index entries/object: 17; create acknowledgement returns before leaf/index finalization, which is drained before query measurements.
- Memory (idle / loaded / peak RSS): 60.58 MiB / 1401.78 MiB / 1552.00 MiB.
- Memory allocation: 25% of system memory; requested / effective budget: 1959.55 MiB / 1959.55 MiB.
- Incremental memory/object: 7031.767 bytes RSS; incremental heap: 1102.65 MiB.
- CPU: 221487.390 ms user + 115151.490 ms system; 136.587% utilization.

| Operation | First ms | Warm min ms | Warm max ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| singleCreate | 1.095 | 0.320 | 0.756 | 0.471 | 0.442 | 0.642 | 0.756 | 2,103 ops/s |
| uuidRead | 0.250 | 0.020 | 1.554 | 0.076 | 0.029 | 0.098 | 1.554 | 12,702 ops/s |
| equality | 5.651 | 3.870 | 8.275 | 4.768 | 4.537 | 5.911 | 8.275 | 206 ops/s |
| nestedEquality | 12.885 | 11.386 | 18.591 | 12.685 | 12.204 | 15.185 | 18.591 | 79 ops/s |
| numericRange | 6.919 | 5.241 | 7.761 | 6.294 | 5.920 | 7.657 | 7.761 | 158 ops/s |
| and | 11.232 | 10.329 | 14.395 | 11.126 | 10.782 | 12.447 | 14.395 | 90 ops/s |
| or | 3.472 | 2.688 | 7.433 | 3.158 | 2.892 | 4.434 | 7.433 | 307 ops/s |
| singleKeyUpdate | 3.705 | 0.125 | 0.468 | 0.164 | 0.144 | 0.243 | 0.468 | 5,998 ops/s |
| indexedKeyUpdate | 0.450 | 0.106 | 0.927 | 0.162 | 0.128 | 0.228 | 0.927 | 6,090 ops/s |
| numericIncrement | 1.340 | 0.105 | 0.298 | 0.134 | 0.122 | 0.160 | 0.298 | 7,373 ops/s |
| singleDelete | 0.598 | 0.020 | 0.091 | 0.026 | 0.022 | 0.046 | 0.091 | 36,659 ops/s |

| Sustained mode | In-flight | ops/s | p50 ms | p95 ms | p99 ms | CPU utilization |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 80,613 ops/s | 0.010 | 0.015 | 0.032 | 104.826% |
| write | 1 | 18,289 ops/s | 0.045 | 0.080 | 0.116 | 107.816% |
| mixed | 1 | 29,834 ops/s | 0.041 | 0.066 | 0.094 | 102.061% |
| read | 8 | 101,237 ops/s | 0.063 | 0.102 | 0.217 | 100.023% |
| write | 8 | 25,015 ops/s | 0.287 | 0.400 | 0.623 | 100.842% |
| mixed | 8 | 37,819 ops/s | 0.172 | 0.245 | 0.362 | 100.767% |

| Run | Status | Failure / skip reason |
| ---: | --- | --- |
| - | all passed | - |

## Historical v2 lifecycle comparison

No v2 compatibility runs completed; this report contains only the selected standard benchmark baseline.

| v2 metric | Historical summary | Current compatibility median |
| --- | ---: | ---: |
| n/a | retained only in the historical provider summary | n/a |

## Raw results and failures

Raw independent runs and the manifest are stored under `/home/ubuntu/Dev/CoCreateJS/modules/db/test/benchmarks/providers/cocreatedb/results/standard-2026-11-26T18-22-05.815Z`. Status counts: {"successfulRuns":1,"failedRuns":0,"notAttempted":0}. The provider summary is recorded in [summary.json](../summary.json).

## Limits and follow-up

This report measures a single-node CoCreateDB run with adaptive memory residency and local Warm writes. MongoDB and Redis have separate provider adapters and reports; compare their results by operation while accounting for transport, indexing and durability differences. Distributed synchronization, replication, sharding, external persistence durability, server/client separation, and transaction guarantees are out of scope.
