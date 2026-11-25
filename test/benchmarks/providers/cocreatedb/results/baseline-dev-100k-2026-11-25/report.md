# CoCreateDB standardized benchmark results

- Run ID: `baseline-dev-100k-2026-11-25`; executed: 2026-11-25T19:48:21.046Z to 2026-11-25T19:57:06.297Z.
- Source revision: `b11817c6f6cc95218cc577e934eca2a38e4d82a7`; DB version 1.1.0.
- Runtime: v24.18.0 / linux-x64; CPU: AMD EPYC 7571 (2 logical CPUs); RAM: 7838.21 MiB; limit: n/a.
- Method: 3 independent runs/size; 10 warmups and 40 samples per latency operation; 1000 ms sustained runs per workload/concurrency.
- Process model: single in-process Node process; benchmark client and database share CPU/RSS; mode: adaptive; acknowledgement: memory; memory allocation: 25%. local writes are queued after memory acknowledgement; disk drain excluded from request timings.
- No competitor databases, containers, dependencies or datasets were installed or launched.

Each run is a fresh child process and database. Fixture data is generated and hashed in 1,000-record batches. The create/index lifecycle timer spans batch generation, create acknowledgements, and the final index drain; fixture generation time and cumulative time awaiting create acknowledgements are reported separately, and background work can overlap those intervals. The fixture hash is over the canonical pre-ingestion JSON dataset. Correctness checks compare UUID result sets before query timings are accepted. Measured request latency stops before result assertions. Sustained modes are read-only, increment-only writes, or alternating read/write calls; concurrency means outstanding in-process requests, not parallel database threads.

Initialization and readiness are reported separately. Object create acknowledges before leaf finalization and index attachment; the standard runner drains this background work before beginning query measurements. The full create/index lifecycle includes the final drain. Local Warm writes are queued after memory acknowledgement; their disk drain is not included in request timings. External persistence is not configured. CPU and RSS include both the benchmark client and database in the same Node process. Incremental memory/object is an approximate loaded-minus-idle RSS ratio.

| Size | Runs passed | Fixture hash | Create + index ms | Create ops/s | Loaded RSS | Peak RSS |
| ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 100,000 | 3/3 | `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b` | 114849.339 | 871 ops/s | 877.09 MiB | 917.80 MiB |

## 100,000 objects

- Runs: 3/3 passed; fixture hash: `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b`.
- Init: 5.115 ms; readiness: 2.607 ms; first object create: 8.969 ms.
- Bulk create/index lifecycle: 114849.339 ms; 871 ops/s.
- Cumulative create acknowledgement wait: 66935.329 ms; fixture generation: 811.554 ms; final index drain wait: 47085.461 ms.
- Filtered bulk delete: 32.839 ms for 25 leaves.
- Total independent run time: 120689.389 ms.
- Index entries/object: 17; create acknowledgement returns before leaf/index finalization, which is drained before query measurements.
- Memory (idle / loaded / peak RSS): 60.11 MiB / 877.09 MiB / 917.80 MiB.
- Memory allocation: 25% of system memory; requested / effective budget: 1959.55 MiB / 1959.55 MiB.
- Incremental memory/object: 8566.538 bytes RSS; incremental heap: 705.46 MiB.
- CPU: 92070.257 ms user + 38391.247 ms system; 108.855% utilization.

| Operation | First ms | Warm min ms | Warm max ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| singleCreate | 5.017 | 1.221 | 9.167 | 2.774 | 1.984 | 4.643 | 9.167 | 360 ops/s |
| uuidRead | 0.207 | 0.018 | 0.083 | 0.041 | 0.042 | 0.067 | 0.083 | 22,439 ops/s |
| equality | 3.464 | 1.414 | 14.684 | 2.192 | 1.992 | 2.557 | 14.684 | 440 ops/s |
| nestedEquality | 6.450 | 5.060 | 8.398 | 6.095 | 5.726 | 7.813 | 8.398 | 162 ops/s |
| numericRange | 5.477 | 4.082 | 7.033 | 4.520 | 4.375 | 5.564 | 7.033 | 219 ops/s |
| and | 10.439 | 9.053 | 11.910 | 9.776 | 9.547 | 11.210 | 11.910 | 102 ops/s |
| or | 4.931 | 4.115 | 6.672 | 4.575 | 4.315 | 5.806 | 6.672 | 214 ops/s |
| singleKeyUpdate | 3.674 | 0.096 | 2.264 | 0.261 | 0.156 | 0.443 | 2.264 | 3,794 ops/s |
| indexedKeyUpdate | 0.980 | 0.143 | 0.304 | 0.180 | 0.160 | 0.273 | 0.304 | 5,503 ops/s |
| numericIncrement | 1.464 | 0.136 | 0.234 | 0.161 | 0.149 | 0.217 | 0.234 | 6,126 ops/s |
| singleDelete | 1.569 | 0.387 | 0.653 | 0.456 | 0.435 | 0.596 | 0.653 | 2,173 ops/s |

| Sustained mode | In-flight | ops/s | p50 ms | p95 ms | p99 ms | CPU utilization |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 50,053 ops/s | 0.015 | 0.024 | 0.049 | 123.992% |
| write | 1 | 4,983 ops/s | 0.121 | 0.218 | 2.787 | 115.487% |
| mixed | 1 | 12,063 ops/s | 0.097 | 0.163 | 0.214 | 122.622% |

| Run | Status | Failure / skip reason |
| ---: | --- | --- |
| - | all passed | - |

## Historical v2 lifecycle comparison

No v2 compatibility runs completed; this report contains only the selected standard benchmark baseline.

| v2 metric | Historical summary | Current compatibility median |
| --- | ---: | ---: |
| n/a | retained only in the historical provider summary | n/a |

## Raw results and failures

Raw independent runs and the manifest are stored under `/home/ubuntu/Dev/CoCreateJS/modules/db/test/benchmarks/providers/cocreatedb/results/baseline-dev-100k-2026-11-25`. Status counts: {"successfulRuns":3,"failedRuns":0,"notAttempted":0}. The provider summary is recorded in [summary.json](../summary.json).

## Limits and follow-up

This report measures a single-node CoCreateDB run with adaptive memory residency and local Warm writes. MongoDB and Redis have separate provider adapters and reports; compare their results by operation while accounting for transport, indexing and durability differences. Distributed synchronization, replication, sharding, external persistence durability, server/client separation, and transaction guarantees are out of scope.
