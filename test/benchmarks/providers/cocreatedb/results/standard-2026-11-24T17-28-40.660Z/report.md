# CoCreateDB standardized benchmark results

- Run ID: `2026-11-24T17-28-40.660Z`; executed: 2026-11-24T17:28:40.660Z to 2026-11-24T17:45:08.321Z.
- Source revision: `9851ef3f258455952c517eafb2adf9e458d299d5`; DB version 1.1.0.
- Runtime: v24.18.0 / linux-x64; CPU: AMD EPYC 7571 (2 logical CPUs); RAM: 7838.21 MiB; limit: n/a.
- Method: 5 independent runs/size; 10 warmups and 40 samples per latency operation; 5000 ms sustained runs per workload/concurrency.
- Process model: single in-process Node process; benchmark client and database share CPU/RSS; mode: adaptive; acknowledgement: memory; memory allocation: 25%. local writes are queued after memory acknowledgement; disk drain excluded from request timings.
- No competitor databases, containers, dependencies or datasets were installed or launched.

Each run is a fresh child process and database. Fixture data is generated and hashed in 1,000-record batches. The create/index lifecycle timer spans batch generation, create acknowledgements, and the final index drain; fixture generation time and cumulative time awaiting create acknowledgements are reported separately, and background work can overlap those intervals. The fixture hash is over the canonical pre-ingestion JSON dataset. Correctness checks compare UUID result sets before query timings are accepted. Measured request latency stops before result assertions. Sustained modes are read-only, increment-only writes, or alternating read/write calls; concurrency means outstanding in-process requests, not parallel database threads.

Initialization and readiness are reported separately. Object create acknowledges before leaf finalization and index attachment; the standard runner drains this background work before beginning query measurements. The full create/index lifecycle includes the final drain. Local Warm writes are queued after memory acknowledgement; their disk drain is not included in request timings. External persistence is not configured. CPU and RSS include both the benchmark client and database in the same Node process. Incremental memory/object is an approximate loaded-minus-idle RSS ratio.

| Size | Runs passed | Fixture hash | Create + index ms | Create ops/s | Loaded RSS | Peak RSS |
| ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 100,000 | 5/5 | `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b` | 64040.203 | 1,562 ops/s | 723.54 MiB | 858.41 MiB |

## 100,000 objects

- Runs: 5/5 passed; fixture hash: `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b`.
- Init: 7.772 ms; readiness: 1.991 ms; first object create: 1.166 ms.
- Bulk create/index lifecycle: 64040.203 ms; 1,562 ops/s.
- Cumulative create acknowledgement wait: 62607.767 ms; fixture generation: 866.453 ms; final index drain wait: 548.384 ms.
- Filtered bulk delete: 108.462 ms for 25 leaves.
- Total independent run time: 95700.463 ms.
- Index entries/object: 17; create acknowledgement returns before leaf/index finalization, which is drained before query measurements.
- Memory (idle / loaded / peak RSS): 63.06 MiB / 723.54 MiB / 858.41 MiB.
- Memory allocation: 25% of system memory; requested / effective budget: n/a / n/a.
- Incremental memory/object: 6925.640 bytes RSS; incremental heap: 574.03 MiB.
- CPU: 94127.461 ms user + 13214.671 ms system; 111.675% utilization.

| Operation | First ms | Warm min ms | Warm max ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| singleCreate | 0.765 | 0.860 | 2.391 | 1.246 | 1.246 | 2.000 | 2.391 | 797 ops/s |
| uuidRead | 0.276 | 0.032 | 0.253 | 0.052 | 0.045 | 0.076 | 0.253 | 17,885 ops/s |
| equality | 1.701 | 0.816 | 1.751 | 1.135 | 1.120 | 1.397 | 1.751 | 858 ops/s |
| nestedEquality | 1.392 | 0.720 | 2.238 | 1.030 | 1.026 | 1.496 | 2.238 | 948 ops/s |
| numericRange | 1.396 | 0.728 | 5.851 | 1.028 | 0.938 | 1.154 | 5.851 | 953 ops/s |
| and | 8.529 | 5.953 | 8.449 | 6.686 | 6.418 | 7.921 | 8.449 | 149 ops/s |
| or | 4.218 | 3.144 | 5.834 | 3.607 | 3.394 | 4.471 | 5.834 | 275 ops/s |
| singleKeyUpdate | 2.923 | 0.201 | 1.460 | 0.289 | 0.257 | 0.364 | 1.460 | 3,420 ops/s |
| indexedKeyUpdate | 1.462 | 0.208 | 1.133 | 0.286 | 0.274 | 0.431 | 1.133 | 3,458 ops/s |
| numericIncrement | 1.626 | 0.199 | 0.481 | 0.272 | 0.265 | 0.371 | 0.481 | 3,633 ops/s |
| singleDelete | 33.980 | 0.510 | 2.092 | 0.769 | 0.673 | 1.165 | 2.092 | 1,290 ops/s |

| Sustained mode | In-flight | ops/s | p50 ms | p95 ms | p99 ms | CPU utilization |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 63,407 ops/s | 0.012 | 0.021 | 0.045 | 105.555% |
| write | 1 | 5,173 ops/s | 0.170 | 0.261 | 0.391 | 109.075% |
| mixed | 1 | 9,816 ops/s | 0.144 | 0.210 | 0.328 | 102.522% |
| read | 8 | 79,431 ops/s | 0.055 | 0.109 | 0.194 | 100.117% |
| write | 8 | 5,173 ops/s | 0.772 | 1.446 | 2.277 | 101.521% |
| mixed | 8 | 10,377 ops/s | 0.373 | 0.744 | 1.018 | 101.531% |

| Run | Status | Failure / skip reason |
| ---: | --- | --- |
| - | all passed | - |

## Historical v2 lifecycle comparison

No v2 compatibility runs completed; historical results remain preserved in `providers/cocreatedb/results/summary.json` and `baselines/2026-11-19-final`.

| v2 metric | Historical summary | Current compatibility median |
| --- | ---: | ---: |
| n/a | retained only in the historical provider summary | n/a |

## Raw results and failures

Raw independent runs and the manifest are stored under `/home/ubuntu/Dev/CoCreateJS/modules/db/test/benchmarks/providers/cocreatedb/results/standard-2026-11-24T17-28-40.660Z`. Status counts: {"successfulRuns":5,"failedRuns":0,"notAttempted":0}. Provider summary appended to [summary.json](../summary.json) without replacing historical data.

## Limits and follow-up

This report measures a single-node CoCreateDB run with adaptive memory residency and local Warm writes. MongoDB and Redis have separate provider adapters and reports; compare their results by operation while accounting for transport, indexing and durability differences. Distributed synchronization, replication, sharding, external persistence durability, server/client separation, and transaction guarantees are out of scope.
