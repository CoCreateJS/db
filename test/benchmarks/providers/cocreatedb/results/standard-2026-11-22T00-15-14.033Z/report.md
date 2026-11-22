# CoCreateDB standardized benchmark results

- Run ID: `2026-11-22T00-15-14.033Z`; executed: 2026-11-22T00:15:14.033Z to 2026-11-22T00:40:27.144Z.
- Source revision: `9558a965ed301e6ceeebef764eeabed549471255`; DB version 1.0.0.
- Runtime: v24.18.0 / linux-x64; CPU: AMD EPYC 7571 (2 logical CPUs); RAM: 7838.21 MiB; limit: n/a.
- Method: 5 independent runs/size; 10 warmups and 40 samples per latency operation; 5000 ms sustained runs per workload/concurrency.
- Process model: single in-process Node process; benchmark client and database share CPU/RSS; mode: adaptive; acknowledgement: memory; memory allocation: 75%. local writes are queued after memory acknowledgement; disk drain excluded from request timings.
- No competitor databases, containers, dependencies or datasets were installed or launched.

Each run is a fresh child process and database. Fixture data is generated in 1,000-record batches; object generation and fixture hashing are excluded from measured create/index time. The fixture hash is over the canonical pre-ingestion JSON dataset. Correctness checks compare UUID result sets before query timings are accepted. Measured request latency stops before result assertions. Sustained modes are read-only, increment-only writes, or alternating read/write calls; concurrency means outstanding in-process requests, not parallel database threads.

Initialization and readiness are reported separately. Index creation and maintenance are synchronous inside object creation, so create/index is one timed operation. Local Warm writes are queued after memory acknowledgement; their disk drain is not included in request timings. External persistence is not configured. CPU and RSS include both the benchmark client and database in the same Node process. Incremental memory/object is an approximate loaded-minus-idle RSS ratio.

| Size | Runs passed | Fixture hash | Create + index ms | Create ops/s | Loaded RSS | Peak RSS |
| ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 100,000 | 5/5 | `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b` | 34166.345 | 2,927 ops/s | 675.39 MiB | 939.61 MiB |

## 100,000 objects

- Runs: 5/5 passed; fixture hash: `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b`.
- Init: 3.289 ms; readiness: 1.745 ms; first object create: 8.967 ms.
- Bulk create/index: 34166.345 ms; 2,927 ops/s.
- Total independent run time: 86809.868 ms.
- Index entries/object: 17; indexing is synchronous and included in create time.
- Memory (idle / loaded / peak RSS): 62.55 MiB / 675.39 MiB / 939.61 MiB.
- Memory allocation: 75% of system memory; requested / effective budget: 5878.66 MiB / 5169.42 MiB.
- Incremental memory/object: 6422.774 bytes RSS; incremental heap: 525.48 MiB.
- CPU: 61366.223 ms user + 28667.558 ms system; 104.022% utilization.

| Operation | First ms | Warm min ms | Warm max ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| singleCreate | 1.037 | 0.452 | 0.854 | 0.551 | 0.502 | 0.762 | 0.854 | 1,806 ops/s |
| uuidRead | 0.272 | 0.058 | 0.163 | 0.080 | 0.070 | 0.140 | 0.163 | 12,075 ops/s |
| equality | 0.907 | 0.515 | 2.961 | 0.828 | 0.686 | 2.136 | 2.961 | 1,172 ops/s |
| nestedEquality | 1.011 | 0.468 | 2.952 | 0.740 | 0.642 | 0.875 | 2.952 | 1,315 ops/s |
| numericRange | 0.792 | 0.392 | 0.794 | 0.457 | 0.427 | 0.563 | 0.794 | 2,098 ops/s |
| and | 3.594 | 2.494 | 4.137 | 3.334 | 2.878 | 3.609 | 4.137 | 297 ops/s |
| or | 1.725 | 1.382 | 1.979 | 1.560 | 1.446 | 1.711 | 1.979 | 633 ops/s |
| singleKeyUpdate | 2.190 | 0.199 | 0.330 | 0.221 | 0.207 | 0.270 | 0.330 | 4,489 ops/s |
| indexedKeyUpdate | 0.923 | 0.230 | 0.444 | 0.287 | 0.251 | 0.410 | 0.444 | 3,453 ops/s |
| numericIncrement | 1.283 | 0.223 | 0.421 | 0.287 | 0.255 | 0.396 | 0.421 | 3,450 ops/s |
| singleDelete | 18470.662 | 18.441 | 22.329 | 19.523 | 19.334 | 20.788 | 22.329 | 51 ops/s |

| Sustained mode | In-flight | ops/s | p50 ms | p95 ms | p99 ms | CPU utilization |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 18,237 ops/s | 0.046 | 0.074 | 0.102 | 104.010% |
| write | 1 | 4,710 ops/s | 0.186 | 0.270 | 0.347 | 106.392% |
| mixed | 1 | 7,791 ops/s | 0.166 | 0.228 | 0.291 | 101.448% |
| read | 8 | 22,099 ops/s | 0.245 | 0.353 | 0.442 | 100.039% |
| write | 8 | 5,535 ops/s | 0.881 | 1.411 | 1.594 | 101.077% |
| mixed | 8 | 8,427 ops/s | 0.630 | 0.940 | 1.184 | 100.878% |

| Run | Status | Failure / skip reason |
| ---: | --- | --- |
| - | all passed | - |

## Historical v2 lifecycle comparison

No v2 compatibility runs completed; historical results remain preserved in `providers/cocreatedb/results/summary.json` and `baselines/2026-11-19-final`.

| v2 metric | Historical summary | Current compatibility median |
| --- | ---: | ---: |
| n/a | retained only in the historical provider summary | n/a |

## Raw results and failures

Raw independent runs and the manifest are stored under `/home/ubuntu/Dev/CoCreateJS/modules/db/test/benchmarks/providers/cocreatedb/results/standard-2026-11-22T00-15-14.033Z`. Status counts: {"successfulRuns":5,"failedRuns":0,"notAttempted":0}. Provider summary appended to [summary.json](../summary.json) without replacing historical data.

## Limits and follow-up

This report measures a single-node CoCreateDB run with adaptive memory residency and local Warm writes. MongoDB and Redis have separate provider adapters and reports; compare their results by operation while accounting for transport, indexing and durability differences. Distributed synchronization, replication, sharding, external persistence durability, server/client separation, and transaction guarantees are out of scope.
