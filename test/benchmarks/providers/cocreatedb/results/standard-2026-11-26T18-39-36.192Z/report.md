# CoCreateDB standardized benchmark results

- Run ID: `2026-11-26T18-39-36.192Z`; executed: 2026-11-26T18:39:36.192Z to 2026-11-26T18:42:04.322Z.
- Source revision: `febb049d5068ff338436dd55acf39411d272a62c`; DB version 1.1.0.
- Runtime: v24.18.0 / linux-x64; CPU: AMD EPYC 7571 (2 logical CPUs); RAM: 7838.21 MiB; limit: n/a.
- Method: 1 independent runs/size; 10 warmups and 40 samples per latency operation; 5000 ms sustained runs per workload/concurrency.
- Process model: single in-process Node process; benchmark client and database share CPU/RSS; mode: adaptive; acknowledgement: memory; memory allocation: 25%. local writes are queued after memory acknowledgement; disk drain excluded from request timings.
- No competitor databases, containers, dependencies or datasets were installed or launched.

Each run is a fresh child process and database. Fixture data is generated and hashed in 1,000-record batches. The create/index lifecycle timer spans batch generation, create acknowledgements, and the final index drain; fixture generation time and cumulative time awaiting create acknowledgements are reported separately, and background work can overlap those intervals. The fixture hash is over the canonical pre-ingestion JSON dataset. Correctness checks compare UUID result sets before query timings are accepted. Measured request latency stops before result assertions. Sustained modes are read-only, increment-only writes, or alternating read/write calls; concurrency means outstanding in-process requests, not parallel database threads.

Initialization and readiness are reported separately. Object create acknowledges before leaf finalization and index attachment; the standard runner drains this background work before beginning query measurements. The full create/index lifecycle includes the final drain. Local Warm writes are queued after memory acknowledgement; their disk drain is not included in request timings. External persistence is not configured. CPU and RSS include both the benchmark client and database in the same Node process. Incremental memory/object is an approximate loaded-minus-idle RSS ratio.

| Size | Runs passed | Fixture hash | Create + index ms | Create ops/s | Loaded RSS | Peak RSS |
| ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 100,000 | 1/1 | `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b` | 96504.554 | 1,036 ops/s | 1021.35 MiB | 1265.02 MiB |

## 100,000 objects

- Runs: 1/1 passed; fixture hash: `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b`.
- Init: 2.999 ms; readiness: 5.051 ms; first object create: 4.591 ms.
- Bulk create/index lifecycle: 96504.554 ms; 1,036 ops/s.
- Cumulative create acknowledgement wait: 8388.078 ms; fixture generation: 896.696 ms; final index drain wait: 87214.658 ms.
- Filtered bulk delete: 3.689 ms for 25 leaves.
- Total independent run time: 134408.168 ms.
- Index entries/object: 17; create acknowledgement returns before leaf/index finalization, which is drained before query measurements.
- Memory (idle / loaded / peak RSS): 61.07 MiB / 1021.35 MiB / 1265.02 MiB.
- Memory allocation: 25% of system memory; requested / effective budget: 1959.55 MiB / 1959.55 MiB.
- Incremental memory/object: 10069.238 bytes RSS; incremental heap: 840.64 MiB.
- CPU: 122091.477 ms user + 59466.318 ms system; 135.079% utilization.

| Operation | First ms | Warm min ms | Warm max ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| singleCreate | 2.984 | 0.454 | 1.234 | 0.936 | 0.984 | 1.199 | 1.234 | 1,062 ops/s |
| uuidRead | 0.221 | 0.022 | 1.031 | 0.065 | 0.040 | 0.077 | 1.031 | 14,643 ops/s |
| equality | 2.446 | 1.023 | 10.797 | 1.560 | 1.271 | 1.798 | 10.797 | 623 ops/s |
| nestedEquality | 5.910 | 3.944 | 8.949 | 4.776 | 4.396 | 5.825 | 8.949 | 207 ops/s |
| numericRange | 4.536 | 3.027 | 5.057 | 3.409 | 3.274 | 4.164 | 5.057 | 290 ops/s |
| and | 8.218 | 7.130 | 9.493 | 7.761 | 7.481 | 8.772 | 9.493 | 128 ops/s |
| or | 3.419 | 2.652 | 4.450 | 2.948 | 2.763 | 3.672 | 4.450 | 329 ops/s |
| singleKeyUpdate | 4.209 | 0.071 | 0.255 | 0.110 | 0.101 | 0.170 | 0.255 | 8,818 ops/s |
| indexedKeyUpdate | 0.361 | 0.072 | 0.236 | 0.100 | 0.079 | 0.165 | 0.236 | 9,844 ops/s |
| numericIncrement | 1.335 | 0.076 | 0.182 | 0.093 | 0.082 | 0.140 | 0.182 | 10,558 ops/s |
| singleDelete | 0.687 | 0.020 | 0.112 | 0.031 | 0.023 | 0.064 | 0.112 | 30,299 ops/s |

| Sustained mode | In-flight | ops/s | p50 ms | p95 ms | p99 ms | CPU utilization |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 83,605 ops/s | 0.009 | 0.015 | 0.031 | 105.507% |
| write | 1 | 18,978 ops/s | 0.044 | 0.076 | 0.109 | 107.390% |
| mixed | 1 | 29,772 ops/s | 0.041 | 0.068 | 0.096 | 101.567% |
| read | 8 | 109,215 ops/s | 0.060 | 0.092 | 0.143 | 100.175% |
| write | 8 | 25,996 ops/s | 0.279 | 0.364 | 0.495 | 100.798% |
| mixed | 8 | 38,519 ops/s | 0.169 | 0.239 | 0.310 | 100.590% |

| Run | Status | Failure / skip reason |
| ---: | --- | --- |
| - | all passed | - |

## Historical v2 lifecycle comparison

No v2 compatibility runs completed; this report contains only the selected standard benchmark baseline.

| v2 metric | Historical summary | Current compatibility median |
| --- | ---: | ---: |
| n/a | retained only in the historical provider summary | n/a |

## Raw results and failures

Raw independent runs and the manifest are stored under `/home/ubuntu/Dev/CoCreateJS/modules/db/test/benchmarks/providers/cocreatedb/results/standard-2026-11-26T18-39-36.192Z`. Status counts: {"successfulRuns":1,"failedRuns":0,"notAttempted":0}. The provider summary is recorded in [summary.json](../summary.json).

## Limits and follow-up

This report measures a single-node CoCreateDB run with adaptive memory residency and local Warm writes. MongoDB and Redis have separate provider adapters and reports; compare their results by operation while accounting for transport, indexing and durability differences. Distributed synchronization, replication, sharding, external persistence durability, server/client separation, and transaction guarantees are out of scope.
