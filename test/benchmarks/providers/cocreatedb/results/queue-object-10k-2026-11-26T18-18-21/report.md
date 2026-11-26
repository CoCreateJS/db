# CoCreateDB standardized benchmark results

- Run ID: `2026-11-26T18-18-51.007Z`; executed: 2026-11-26T18:18:51.007Z to 2026-11-26T18:19:14.907Z.
- Source revision: `febb049d5068ff338436dd55acf39411d272a62c`; DB version 1.1.0.
- Runtime: v24.18.0 / linux-x64; CPU: AMD EPYC 7571 (2 logical CPUs); RAM: 7838.21 MiB; limit: n/a.
- Method: 1 independent runs/size; 10 warmups and 40 samples per latency operation; 1000 ms sustained runs per workload/concurrency.
- Process model: single in-process Node process; benchmark client and database share CPU/RSS; mode: adaptive; acknowledgement: memory; memory allocation: 25%. local writes are queued after memory acknowledgement; disk drain excluded from request timings.
- No competitor databases, containers, dependencies or datasets were installed or launched.

Each run is a fresh child process and database. Fixture data is generated and hashed in 1,000-record batches. The create/index lifecycle timer spans batch generation, create acknowledgements, and the final index drain; fixture generation time and cumulative time awaiting create acknowledgements are reported separately, and background work can overlap those intervals. The fixture hash is over the canonical pre-ingestion JSON dataset. Correctness checks compare UUID result sets before query timings are accepted. Measured request latency stops before result assertions. Sustained modes are read-only, increment-only writes, or alternating read/write calls; concurrency means outstanding in-process requests, not parallel database threads.

Initialization and readiness are reported separately. Object create acknowledges before leaf finalization and index attachment; the standard runner drains this background work before beginning query measurements. The full create/index lifecycle includes the final drain. Local Warm writes are queued after memory acknowledgement; their disk drain is not included in request timings. External persistence is not configured. CPU and RSS include both the benchmark client and database in the same Node process. Incremental memory/object is an approximate loaded-minus-idle RSS ratio.

| Size | Runs passed | Fixture hash | Create + index ms | Create ops/s | Loaded RSS | Peak RSS |
| ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 10,000 | 1/1 | `767927150f41a6967e99ab0e05f11128ba4f408f1b9bfc5e1fc753a84119ac8f` | 10504.007 | 952 ops/s | 272.04 MiB | 294.14 MiB |

## 10,000 objects

- Runs: 1/1 passed; fixture hash: `767927150f41a6967e99ab0e05f11128ba4f408f1b9bfc5e1fc753a84119ac8f`.
- Init: 3.795 ms; readiness: 5.076 ms; first object create: 4.876 ms.
- Bulk create/index lifecycle: 10504.007 ms; 952 ops/s.
- Cumulative create acknowledgement wait: 1170.726 ms; fixture generation: 98.154 ms; final index drain wait: 9233.235 ms.
- Filtered bulk delete: 1.342 ms for 25 leaves.
- Total independent run time: 18215.185 ms.
- Index entries/object: 17; create acknowledgement returns before leaf/index finalization, which is drained before query measurements.
- Memory (idle / loaded / peak RSS): 60.82 MiB / 272.04 MiB / 294.14 MiB.
- Memory allocation: 25% of system memory; requested / effective budget: 1959.55 MiB / 1959.55 MiB.
- Incremental memory/object: 22147.891 bytes RSS; incremental heap: 97.51 MiB.
- CPU: 18129.323 ms user + 5705.595 ms system; 130.852% utilization.

| Operation | First ms | Warm min ms | Warm max ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| singleCreate | 1.419 | 0.238 | 1.645 | 0.356 | 0.303 | 0.573 | 1.645 | 2,785 ops/s |
| uuidRead | 0.211 | 0.015 | 0.466 | 0.043 | 0.029 | 0.062 | 0.466 | 20,475 ops/s |
| equality | 2.369 | 1.062 | 7.288 | 1.715 | 1.601 | 1.854 | 7.288 | 567 ops/s |
| nestedEquality | 2.750 | 1.406 | 4.997 | 2.240 | 2.224 | 2.510 | 4.997 | 436 ops/s |
| numericRange | 1.934 | 1.100 | 3.767 | 1.529 | 1.387 | 2.549 | 3.767 | 638 ops/s |
| and | 1.785 | 0.988 | 1.932 | 1.160 | 1.096 | 1.628 | 1.932 | 838 ops/s |
| or | 3.476 | 2.501 | 4.708 | 3.165 | 2.982 | 4.007 | 4.708 | 308 ops/s |
| singleKeyUpdate | 3.368 | 0.070 | 0.391 | 0.113 | 0.100 | 0.178 | 0.391 | 8,651 ops/s |
| indexedKeyUpdate | 0.724 | 0.072 | 0.373 | 0.115 | 0.093 | 0.215 | 0.373 | 8,520 ops/s |
| numericIncrement | 1.501 | 0.077 | 0.217 | 0.107 | 0.092 | 0.165 | 0.217 | 9,226 ops/s |
| singleDelete | 0.633 | 0.019 | 0.067 | 0.022 | 0.020 | 0.026 | 0.067 | 43,577 ops/s |

| Sustained mode | In-flight | ops/s | p50 ms | p95 ms | p99 ms | CPU utilization |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 69,226 ops/s | 0.010 | 0.019 | 0.039 | 132.798% |
| write | 1 | 12,326 ops/s | 0.069 | 0.115 | 0.166 | 121.420% |
| mixed | 1 | 14,620 ops/s | 0.055 | 0.105 | 0.166 | 100.301% |
| read | 8 | 111,119 ops/s | 0.059 | 0.091 | 0.168 | 102.958% |
| write | 8 | 23,805 ops/s | 0.297 | 0.452 | 0.580 | 108.003% |
| mixed | 8 | 37,613 ops/s | 0.174 | 0.253 | 0.342 | 100.658% |

| Run | Status | Failure / skip reason |
| ---: | --- | --- |
| - | all passed | - |

## Historical v2 lifecycle comparison

No v2 compatibility runs completed; this report contains only the selected standard benchmark baseline.

| v2 metric | Historical summary | Current compatibility median |
| --- | ---: | ---: |
| n/a | retained only in the historical provider summary | n/a |

## Raw results and failures

Raw independent runs and the manifest are stored under `/home/ubuntu/Dev/CoCreateJS/modules/db/test/benchmarks/providers/cocreatedb/results/queue-object-10k-2026-11-26T18-18-21`. Status counts: {"successfulRuns":1,"failedRuns":0,"notAttempted":0}. The provider summary is recorded in [summary.json](../summary.json).

## Limits and follow-up

This report measures a single-node CoCreateDB run with adaptive memory residency and local Warm writes. MongoDB and Redis have separate provider adapters and reports; compare their results by operation while accounting for transport, indexing and durability differences. Distributed synchronization, replication, sharding, external persistence durability, server/client separation, and transaction guarantees are out of scope.
