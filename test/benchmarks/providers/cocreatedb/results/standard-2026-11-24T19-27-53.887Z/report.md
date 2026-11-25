# CoCreateDB standardized benchmark results

- Run ID: `2026-11-24T19-27-53.887Z`; executed: 2026-11-24T19:27:53.887Z to 2026-11-24T19:44:12.430Z.
- Source revision: `9851ef3f258455952c517eafb2adf9e458d299d5`; DB version 1.1.0.
- Runtime: v24.18.0 / linux-x64; CPU: AMD EPYC 7571 (2 logical CPUs); RAM: 7838.21 MiB; limit: n/a.
- Method: 5 independent runs/size; 10 warmups and 40 samples per latency operation; 5000 ms sustained runs per workload/concurrency.
- Process model: single in-process Node process; benchmark client and database share CPU/RSS; mode: adaptive; acknowledgement: memory; memory allocation: 25%. local writes are queued after memory acknowledgement; disk drain excluded from request timings.
- No competitor databases, containers, dependencies or datasets were installed or launched.

Each run is a fresh child process and database. Fixture data is generated and hashed in 1,000-record batches. The create/index lifecycle timer spans batch generation, create acknowledgements, and the final index drain; fixture generation time and cumulative time awaiting create acknowledgements are reported separately, and background work can overlap those intervals. The fixture hash is over the canonical pre-ingestion JSON dataset. Correctness checks compare UUID result sets before query timings are accepted. Measured request latency stops before result assertions. Sustained modes are read-only, increment-only writes, or alternating read/write calls; concurrency means outstanding in-process requests, not parallel database threads.

Initialization and readiness are reported separately. Object create acknowledges before leaf finalization and index attachment; the standard runner drains this background work before beginning query measurements. The full create/index lifecycle includes the final drain. Local Warm writes are queued after memory acknowledgement; their disk drain is not included in request timings. External persistence is not configured. CPU and RSS include both the benchmark client and database in the same Node process. Incremental memory/object is an approximate loaded-minus-idle RSS ratio.

| Size | Runs passed | Fixture hash | Create + index ms | Create ops/s | Loaded RSS | Peak RSS |
| ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 100,000 | 5/5 | `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b` | 63129.915 | 1,584 ops/s | 729.54 MiB | 880.19 MiB |

## 100,000 objects

- Runs: 5/5 passed; fixture hash: `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b`.
- Init: 6.489 ms; readiness: 2.156 ms; first object create: 1.137 ms.
- Bulk create/index lifecycle: 63129.915 ms; 1,584 ops/s.
- Cumulative create acknowledgement wait: 61768.117 ms; fixture generation: 856.779 ms; final index drain wait: 501.785 ms.
- Filtered bulk delete: 101.396 ms for 25 leaves.
- Total independent run time: 94580.592 ms.
- Index entries/object: 17; create acknowledgement returns before leaf/index finalization, which is drained before query measurements.
- Memory (idle / loaded / peak RSS): 63.09 MiB / 729.54 MiB / 880.19 MiB.
- Memory allocation: 25% of system memory; requested / effective budget: n/a / n/a.
- Incremental memory/object: 6986.506 bytes RSS; incremental heap: 527.71 MiB.
- CPU: 93318.994 ms user + 12605.286 ms system; 112.233% utilization.

| Operation | First ms | Warm min ms | Warm max ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| singleCreate | 0.756 | 0.811 | 2.437 | 1.174 | 1.099 | 1.528 | 2.437 | 846 ops/s |
| uuidRead | 0.375 | 0.031 | 0.332 | 0.067 | 0.059 | 0.109 | 0.332 | 13,303 ops/s |
| equality | 1.929 | 0.681 | 1.392 | 0.897 | 0.898 | 1.151 | 1.392 | 1,075 ops/s |
| nestedEquality | 1.293 | 0.638 | 6.209 | 1.156 | 0.907 | 3.091 | 6.209 | 849 ops/s |
| numericRange | 1.183 | 0.599 | 2.470 | 0.913 | 0.854 | 1.136 | 2.470 | 1,069 ops/s |
| and | 7.923 | 4.733 | 6.408 | 5.317 | 5.053 | 6.254 | 6.408 | 187 ops/s |
| or | 3.413 | 2.299 | 3.796 | 2.799 | 2.635 | 3.325 | 3.796 | 354 ops/s |
| singleKeyUpdate | 3.293 | 0.254 | 0.653 | 0.364 | 0.356 | 0.427 | 0.653 | 2,732 ops/s |
| indexedKeyUpdate | 1.518 | 0.299 | 0.626 | 0.377 | 0.344 | 0.529 | 0.626 | 2,630 ops/s |
| numericIncrement | 1.884 | 0.297 | 0.560 | 0.378 | 0.361 | 0.498 | 0.560 | 2,625 ops/s |
| singleDelete | 43.473 | 0.567 | 1.417 | 0.801 | 0.748 | 1.121 | 1.417 | 1,242 ops/s |

| Sustained mode | In-flight | ops/s | p50 ms | p95 ms | p99 ms | CPU utilization |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 44,235 ops/s | 0.018 | 0.034 | 0.062 | 105.552% |
| write | 1 | 3,465 ops/s | 0.251 | 0.386 | 0.562 | 112.028% |
| mixed | 1 | 6,519 ops/s | 0.211 | 0.282 | 0.412 | 103.344% |
| read | 8 | 53,883 ops/s | 0.083 | 0.157 | 0.277 | 100.229% |
| write | 8 | 3,814 ops/s | 1.144 | 2.094 | 2.804 | 102.203% |
| mixed | 8 | 7,101 ops/s | 0.531 | 1.088 | 1.393 | 102.170% |

| Run | Status | Failure / skip reason |
| ---: | --- | --- |
| - | all passed | - |

## Historical v2 lifecycle comparison

No v2 compatibility runs completed; historical results remain preserved in `providers/cocreatedb/results/summary.json` and `baselines/2026-11-19-final`.

| v2 metric | Historical summary | Current compatibility median |
| --- | ---: | ---: |
| n/a | retained only in the historical provider summary | n/a |

## Raw results and failures

Raw independent runs and the manifest are stored under `/home/ubuntu/Dev/CoCreateJS/modules/db/test/benchmarks/providers/cocreatedb/results/standard-2026-11-24T19-27-53.887Z`. Status counts: {"successfulRuns":5,"failedRuns":0,"notAttempted":0}. Provider summary appended to [summary.json](../summary.json) without replacing historical data.

## Limits and follow-up

This report measures a single-node CoCreateDB run with adaptive memory residency and local Warm writes. MongoDB and Redis have separate provider adapters and reports; compare their results by operation while accounting for transport, indexing and durability differences. Distributed synchronization, replication, sharding, external persistence durability, server/client separation, and transaction guarantees are out of scope.
