# CoCreateDB standardized benchmark results

- Run ID: `2026-11-26T17-26-06.493Z`; executed: 2026-11-26T17:26:06.493Z to 2026-11-26T17:26:56.817Z.
- Source revision: `8ebc6d156fb6c19878e0e04a1af1b2a91c8ce663`; DB version 1.1.0.
- Runtime: v24.18.0 / linux-x64; CPU: AMD EPYC 7571 (2 logical CPUs); RAM: 7838.21 MiB; limit: n/a.
- Method: 1 independent runs/size; 10 warmups and 40 samples per latency operation; 5000 ms sustained runs per workload/concurrency.
- Process model: single in-process Node process; benchmark client and database share CPU/RSS; mode: adaptive; acknowledgement: memory; memory allocation: 25%. local writes are queued after memory acknowledgement; disk drain excluded from request timings.
- No competitor databases, containers, dependencies or datasets were installed or launched.

Each run is a fresh child process and database. Fixture data is generated and hashed in 1,000-record batches. The create/index lifecycle timer spans batch generation, create acknowledgements, and the final index drain; fixture generation time and cumulative time awaiting create acknowledgements are reported separately, and background work can overlap those intervals. The fixture hash is over the canonical pre-ingestion JSON dataset. Correctness checks compare UUID result sets before query timings are accepted. Measured request latency stops before result assertions. Sustained modes are read-only, increment-only writes, or alternating read/write calls; concurrency means outstanding in-process requests, not parallel database threads.

Initialization and readiness are reported separately. Object create acknowledges before leaf finalization and index attachment; the standard runner drains this background work before beginning query measurements. The full create/index lifecycle includes the final drain. Local Warm writes are queued after memory acknowledgement; their disk drain is not included in request timings. External persistence is not configured. CPU and RSS include both the benchmark client and database in the same Node process. Incremental memory/object is an approximate loaded-minus-idle RSS ratio.

| Size | Runs passed | Fixture hash | Create + index ms | Create ops/s | Loaded RSS | Peak RSS |
| ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 10,000 | 1/1 | `767927150f41a6967e99ab0e05f11128ba4f408f1b9bfc5e1fc753a84119ac8f` | 10982.829 | 911 ops/s | 231.84 MiB | 405.61 MiB |

## 10,000 objects

- Runs: 1/1 passed; fixture hash: `767927150f41a6967e99ab0e05f11128ba4f408f1b9bfc5e1fc753a84119ac8f`.
- Init: 2.773 ms; readiness: 5.000 ms; first object create: 4.426 ms.
- Bulk create/index lifecycle: 10982.829 ms; 911 ops/s.
- Cumulative create acknowledgement wait: 1162.266 ms; fixture generation: 107.063 ms; final index drain wait: 9711.420 ms.
- Filtered bulk delete: 1.403 ms for 25 leaves.
- Total independent run time: 43003.623 ms.
- Index entries/object: 17; create acknowledgement returns before leaf/index finalization, which is drained before query measurements.
- Memory (idle / loaded / peak RSS): 60.87 MiB / 231.84 MiB / 405.61 MiB.
- Memory allocation: 25% of system memory; requested / effective budget: 1959.55 MiB / 1959.55 MiB.
- Incremental memory/object: 17926.963 bytes RSS; incremental heap: 60.25 MiB.
- CPU: 43145.710 ms user + 5314.391 ms system; 112.688% utilization.

| Operation | First ms | Warm min ms | Warm max ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| singleCreate | 0.922 | 0.229 | 0.435 | 0.277 | 0.259 | 0.360 | 0.435 | 3,571 ops/s |
| uuidRead | 0.240 | 0.024 | 0.077 | 0.041 | 0.040 | 0.063 | 0.077 | 19,161 ops/s |
| equality | 2.858 | 1.200 | 10.585 | 2.090 | 1.725 | 3.042 | 10.585 | 468 ops/s |
| nestedEquality | 2.482 | 1.586 | 5.245 | 2.287 | 2.033 | 2.929 | 5.245 | 430 ops/s |
| numericRange | 2.667 | 1.071 | 2.241 | 1.330 | 1.209 | 1.900 | 2.241 | 733 ops/s |
| and | 1.707 | 0.997 | 1.999 | 1.459 | 1.519 | 1.824 | 1.999 | 628 ops/s |
| or | 4.841 | 2.726 | 4.362 | 3.027 | 2.911 | 3.566 | 4.362 | 322 ops/s |
| singleKeyUpdate | 3.775 | 0.072 | 0.270 | 0.111 | 0.107 | 0.166 | 0.270 | 8,885 ops/s |
| indexedKeyUpdate | 0.405 | 0.074 | 0.179 | 0.099 | 0.081 | 0.171 | 0.179 | 9,859 ops/s |
| numericIncrement | 1.313 | 0.080 | 0.264 | 0.103 | 0.088 | 0.149 | 0.264 | 9,553 ops/s |
| singleDelete | 0.447 | 0.020 | 0.063 | 0.026 | 0.022 | 0.046 | 0.063 | 37,163 ops/s |

| Sustained mode | In-flight | ops/s | p50 ms | p95 ms | p99 ms | CPU utilization |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 82,808 ops/s | 0.009 | 0.016 | 0.030 | 103.301% |
| write | 1 | 19,447 ops/s | 0.043 | 0.076 | 0.115 | 107.243% |
| mixed | 1 | 31,930 ops/s | 0.040 | 0.066 | 0.089 | 101.189% |
| read | 8 | 114,234 ops/s | 0.058 | 0.085 | 0.146 | 99.890% |
| write | 8 | 26,732 ops/s | 0.270 | 0.400 | 0.500 | 100.106% |
| mixed | 8 | 40,616 ops/s | 0.164 | 0.241 | 0.317 | 100.015% |

| Run | Status | Failure / skip reason |
| ---: | --- | --- |
| - | all passed | - |

## Historical v2 lifecycle comparison

No v2 compatibility runs completed; this report contains only the selected standard benchmark baseline.

| v2 metric | Historical summary | Current compatibility median |
| --- | ---: | ---: |
| n/a | retained only in the historical provider summary | n/a |

## Raw results and failures

Raw independent runs and the manifest are stored under `/home/ubuntu/Dev/CoCreateJS/modules/db/test/benchmarks/providers/cocreatedb/results/standard-2026-11-26T17-26-06.493Z`. Status counts: {"successfulRuns":1,"failedRuns":0,"notAttempted":0}. The provider summary is recorded in [summary.json](../summary.json).

## Limits and follow-up

This report measures a single-node CoCreateDB run with adaptive memory residency and local Warm writes. MongoDB and Redis have separate provider adapters and reports; compare their results by operation while accounting for transport, indexing and durability differences. Distributed synchronization, replication, sharding, external persistence durability, server/client separation, and transaction guarantees are out of scope.
