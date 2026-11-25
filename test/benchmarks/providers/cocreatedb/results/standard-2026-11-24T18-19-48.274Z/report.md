# CoCreateDB standardized benchmark results

- Run ID: `2026-11-24T18-19-48.274Z`; executed: 2026-11-24T18:19:48.274Z to 2026-11-24T18:36:22.273Z.
- Source revision: `9851ef3f258455952c517eafb2adf9e458d299d5`; DB version 1.1.0.
- Runtime: v24.18.0 / linux-x64; CPU: AMD EPYC 7571 (2 logical CPUs); RAM: 7838.21 MiB; limit: n/a.
- Method: 5 independent runs/size; 10 warmups and 40 samples per latency operation; 5000 ms sustained runs per workload/concurrency.
- Process model: single in-process Node process; benchmark client and database share CPU/RSS; mode: adaptive; acknowledgement: memory; memory allocation: 25%. local writes are queued after memory acknowledgement; disk drain excluded from request timings.
- No competitor databases, containers, dependencies or datasets were installed or launched.

Each run is a fresh child process and database. Fixture data is generated and hashed in 1,000-record batches. The create/index lifecycle timer spans batch generation, create acknowledgements, and the final index drain; fixture generation time and cumulative time awaiting create acknowledgements are reported separately, and background work can overlap those intervals. The fixture hash is over the canonical pre-ingestion JSON dataset. Correctness checks compare UUID result sets before query timings are accepted. Measured request latency stops before result assertions. Sustained modes are read-only, increment-only writes, or alternating read/write calls; concurrency means outstanding in-process requests, not parallel database threads.

Initialization and readiness are reported separately. Object create acknowledges before leaf finalization and index attachment; the standard runner drains this background work before beginning query measurements. The full create/index lifecycle includes the final drain. Local Warm writes are queued after memory acknowledgement; their disk drain is not included in request timings. External persistence is not configured. CPU and RSS include both the benchmark client and database in the same Node process. Incremental memory/object is an approximate loaded-minus-idle RSS ratio.

| Size | Runs passed | Fixture hash | Create + index ms | Create ops/s | Loaded RSS | Peak RSS |
| ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 100,000 | 5/5 | `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b` | 64679.141 | 1,546 ops/s | 723.73 MiB | 855.78 MiB |

## 100,000 objects

- Runs: 5/5 passed; fixture hash: `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b`.
- Init: 6.425 ms; readiness: 1.961 ms; first object create: 1.172 ms.
- Bulk create/index lifecycle: 64679.141 ms; 1,546 ops/s.
- Cumulative create acknowledgement wait: 63311.136 ms; fixture generation: 853.076 ms; final index drain wait: 541.935 ms.
- Filtered bulk delete: 106.374 ms for 25 leaves.
- Total independent run time: 96297.313 ms.
- Index entries/object: 17; create acknowledgement returns before leaf/index finalization, which is drained before query measurements.
- Memory (idle / loaded / peak RSS): 63.38 MiB / 723.73 MiB / 855.78 MiB.
- Memory allocation: 25% of system memory; requested / effective budget: n/a / n/a.
- Incremental memory/object: 6928.753 bytes RSS; incremental heap: 570.84 MiB.
- CPU: 93531.905 ms user + 13220.017 ms system; 111.568% utilization.

| Operation | First ms | Warm min ms | Warm max ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| singleCreate | 0.991 | 0.839 | 2.254 | 1.426 | 1.397 | 1.879 | 2.254 | 698 ops/s |
| uuidRead | 0.240 | 0.035 | 0.115 | 0.054 | 0.049 | 0.095 | 0.115 | 15,933 ops/s |
| equality | 1.836 | 0.934 | 1.703 | 1.284 | 1.346 | 1.574 | 1.703 | 759 ops/s |
| nestedEquality | 1.813 | 0.847 | 6.123 | 1.249 | 1.043 | 1.996 | 6.123 | 786 ops/s |
| numericRange | 1.463 | 0.814 | 1.526 | 1.053 | 1.053 | 1.432 | 1.526 | 929 ops/s |
| and | 9.055 | 6.157 | 9.060 | 7.042 | 6.708 | 8.386 | 9.060 | 141 ops/s |
| or | 4.146 | 3.264 | 5.180 | 3.726 | 3.559 | 4.669 | 5.180 | 266 ops/s |
| singleKeyUpdate | 2.674 | 0.179 | 1.494 | 0.286 | 0.256 | 0.371 | 1.494 | 3,458 ops/s |
| indexedKeyUpdate | 1.592 | 0.203 | 0.568 | 0.290 | 0.252 | 0.415 | 0.568 | 3,408 ops/s |
| numericIncrement | 1.725 | 0.201 | 0.400 | 0.268 | 0.253 | 0.375 | 0.400 | 3,695 ops/s |
| singleDelete | 33.367 | 0.518 | 1.316 | 0.779 | 0.731 | 1.186 | 1.316 | 1,276 ops/s |

| Sustained mode | In-flight | ops/s | p50 ms | p95 ms | p99 ms | CPU utilization |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 58,387 ops/s | 0.013 | 0.026 | 0.054 | 106.043% |
| write | 1 | 4,763 ops/s | 0.178 | 0.302 | 0.488 | 109.008% |
| mixed | 1 | 9,429 ops/s | 0.147 | 0.230 | 0.351 | 102.434% |
| read | 8 | 73,628 ops/s | 0.060 | 0.118 | 0.203 | 100.164% |
| write | 8 | 5,229 ops/s | 0.793 | 1.441 | 2.283 | 101.510% |
| mixed | 8 | 9,960 ops/s | 0.386 | 0.815 | 1.147 | 101.626% |

| Run | Status | Failure / skip reason |
| ---: | --- | --- |
| - | all passed | - |

## Historical v2 lifecycle comparison

No v2 compatibility runs completed; historical results remain preserved in `providers/cocreatedb/results/summary.json` and `baselines/2026-11-19-final`.

| v2 metric | Historical summary | Current compatibility median |
| --- | ---: | ---: |
| n/a | retained only in the historical provider summary | n/a |

## Raw results and failures

Raw independent runs and the manifest are stored under `/home/ubuntu/Dev/CoCreateJS/modules/db/test/benchmarks/providers/cocreatedb/results/standard-2026-11-24T18-19-48.274Z`. Status counts: {"successfulRuns":5,"failedRuns":0,"notAttempted":0}. Provider summary appended to [summary.json](../summary.json) without replacing historical data.

## Limits and follow-up

This report measures a single-node CoCreateDB run with adaptive memory residency and local Warm writes. MongoDB and Redis have separate provider adapters and reports; compare their results by operation while accounting for transport, indexing and durability differences. Distributed synchronization, replication, sharding, external persistence durability, server/client separation, and transaction guarantees are out of scope.
