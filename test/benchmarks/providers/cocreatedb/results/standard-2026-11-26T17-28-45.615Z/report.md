# CoCreateDB standardized benchmark results

- Run ID: `2026-11-26T17-28-45.615Z`; executed: 2026-11-26T17:28:45.615Z to 2026-11-26T17:32:14.016Z.
- Source revision: `8ebc6d156fb6c19878e0e04a1af1b2a91c8ce663`; DB version 1.1.0.
- Runtime: v24.18.0 / linux-x64; CPU: AMD EPYC 7571 (2 logical CPUs); RAM: 7838.21 MiB; limit: n/a.
- Method: 1 independent runs/size; 10 warmups and 40 samples per latency operation; 5000 ms sustained runs per workload/concurrency.
- Process model: single in-process Node process; benchmark client and database share CPU/RSS; mode: adaptive; acknowledgement: memory; memory allocation: 25%. local writes are queued after memory acknowledgement; disk drain excluded from request timings.
- No competitor databases, containers, dependencies or datasets were installed or launched.

Each run is a fresh child process and database. Fixture data is generated and hashed in 1,000-record batches. The create/index lifecycle timer spans batch generation, create acknowledgements, and the final index drain; fixture generation time and cumulative time awaiting create acknowledgements are reported separately, and background work can overlap those intervals. The fixture hash is over the canonical pre-ingestion JSON dataset. Correctness checks compare UUID result sets before query timings are accepted. Measured request latency stops before result assertions. Sustained modes are read-only, increment-only writes, or alternating read/write calls; concurrency means outstanding in-process requests, not parallel database threads.

Initialization and readiness are reported separately. Object create acknowledges before leaf finalization and index attachment; the standard runner drains this background work before beginning query measurements. The full create/index lifecycle includes the final drain. Local Warm writes are queued after memory acknowledgement; their disk drain is not included in request timings. External persistence is not configured. CPU and RSS include both the benchmark client and database in the same Node process. Incremental memory/object is an approximate loaded-minus-idle RSS ratio.

| Size | Runs passed | Fixture hash | Create + index ms | Create ops/s | Loaded RSS | Peak RSS |
| ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 100,000 | 1/1 | `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b` | 155166.620 | 644 ops/s | 974.00 MiB | 1136.83 MiB |

## 100,000 objects

- Runs: 1/1 passed; fixture hash: `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b`.
- Init: 3.515 ms; readiness: 5.643 ms; first object create: 4.793 ms.
- Bulk create/index lifecycle: 155166.620 ms; 644 ops/s.
- Cumulative create acknowledgement wait: 11597.717 ms; fixture generation: 1030.081 ms; final index drain wait: 142533.577 ms.
- Filtered bulk delete: 5.078 ms for 25 leaves.
- Total independent run time: 193252.899 ms.
- Index entries/object: 17; create acknowledgement returns before leaf/index finalization, which is drained before query measurements.
- Memory (idle / loaded / peak RSS): 60.89 MiB / 974.00 MiB / 1136.83 MiB.
- Memory allocation: 25% of system memory; requested / effective budget: 1959.55 MiB / 1959.55 MiB.
- Incremental memory/object: 9574.687 bytes RSS; incremental heap: 780.62 MiB.
- CPU: 172579.990 ms user + 60330.021 ms system; 120.521% utilization.

| Operation | First ms | Warm min ms | Warm max ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| singleCreate | 2.161 | 0.235 | 3.223 | 0.451 | 0.335 | 0.826 | 3.223 | 2,201 ops/s |
| uuidRead | 0.208 | 0.023 | 0.981 | 0.061 | 0.032 | 0.078 | 0.981 | 15,512 ops/s |
| equality | 3.092 | 0.980 | 1.994 | 1.361 | 1.399 | 1.726 | 1.994 | 711 ops/s |
| nestedEquality | 10.676 | 4.145 | 6.483 | 4.772 | 4.461 | 5.993 | 6.483 | 208 ops/s |
| numericRange | 4.640 | 3.230 | 5.458 | 3.556 | 3.412 | 4.446 | 5.458 | 277 ops/s |
| and | 8.998 | 7.140 | 9.968 | 7.985 | 7.645 | 9.282 | 9.968 | 125 ops/s |
| or | 3.677 | 2.584 | 4.353 | 2.919 | 2.797 | 3.759 | 4.353 | 334 ops/s |
| singleKeyUpdate | 3.453 | 0.069 | 0.467 | 0.111 | 0.086 | 0.167 | 0.467 | 8,874 ops/s |
| indexedKeyUpdate | 0.380 | 0.072 | 0.211 | 0.111 | 0.105 | 0.169 | 0.211 | 8,831 ops/s |
| numericIncrement | 1.568 | 0.076 | 0.159 | 0.091 | 0.080 | 0.144 | 0.159 | 10,746 ops/s |
| singleDelete | 0.642 | 0.029 | 0.065 | 0.035 | 0.032 | 0.046 | 0.065 | 25,819 ops/s |

| Sustained mode | In-flight | ops/s | p50 ms | p95 ms | p99 ms | CPU utilization |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 82,813 ops/s | 0.009 | 0.015 | 0.032 | 105.007% |
| write | 1 | 19,331 ops/s | 0.043 | 0.076 | 0.115 | 107.312% |
| mixed | 1 | 30,323 ops/s | 0.040 | 0.066 | 0.096 | 101.423% |
| read | 8 | 102,081 ops/s | 0.062 | 0.104 | 0.207 | 99.841% |
| write | 8 | 24,422 ops/s | 0.289 | 0.437 | 0.652 | 99.897% |
| mixed | 8 | 38,815 ops/s | 0.170 | 0.239 | 0.352 | 100.100% |

| Run | Status | Failure / skip reason |
| ---: | --- | --- |
| - | all passed | - |

## Historical v2 lifecycle comparison

No v2 compatibility runs completed; this report contains only the selected standard benchmark baseline.

| v2 metric | Historical summary | Current compatibility median |
| --- | ---: | ---: |
| n/a | retained only in the historical provider summary | n/a |

## Raw results and failures

Raw independent runs and the manifest are stored under `/home/ubuntu/Dev/CoCreateJS/modules/db/test/benchmarks/providers/cocreatedb/results/standard-2026-11-26T17-28-45.615Z`. Status counts: {"successfulRuns":1,"failedRuns":0,"notAttempted":0}. The provider summary is recorded in [summary.json](../summary.json).

## Limits and follow-up

This report measures a single-node CoCreateDB run with adaptive memory residency and local Warm writes. MongoDB and Redis have separate provider adapters and reports; compare their results by operation while accounting for transport, indexing and durability differences. Distributed synchronization, replication, sharding, external persistence durability, server/client separation, and transaction guarantees are out of scope.
