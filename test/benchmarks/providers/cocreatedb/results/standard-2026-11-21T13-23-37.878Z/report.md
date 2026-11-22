# CoCreateDB standardized benchmark results

- Run ID: `2026-11-21T13-23-37.878Z`; executed: 2026-11-21T13:23:37.878Z to 2026-11-21T13:26:22.771Z.
- Source revision: `7d9c347d0385de84d9aefa6acbb00dafec9edaa7`; DB version 1.0.0.
- Runtime: v24.18.0 / linux-x64; CPU: AMD EPYC 7571 (2 logical CPUs); RAM: 7838.21 MiB; limit: n/a.
- Method: 5 independent runs/size; 10 warmups and 40 samples per latency operation; 5000 ms sustained runs per workload/concurrency.
- Process model: single in-process Node process; benchmark client and database share CPU/RSS; mode: adaptive; acknowledgement: memory; memory allocation: unknown%. none; no disk or provider writes.
- No competitor databases, containers, dependencies or datasets were installed or launched.

Each run is a fresh child process and database. Fixture data is generated in 1,000-record batches; object generation and fixture hashing are excluded from measured create/index time. The fixture hash is over the canonical pre-ingestion JSON dataset. Correctness checks compare UUID result sets before query timings are accepted. Measured request latency stops before result assertions. Sustained modes are read-only, increment-only writes, or alternating read/write calls; concurrency means outstanding in-process requests, not parallel database threads.

Initialization and readiness are reported separately. Index creation and maintenance are synchronous inside object creation, so create/index is one timed operation. Local Warm writes are queued after memory acknowledgement; their disk drain is not included in request timings. External persistence is not configured. CPU and RSS include both the benchmark client and database in the same Node process. Incremental memory/object is an approximate loaded-minus-idle RSS ratio.

| Size | Runs passed | Fixture hash | Create + index ms | Create ops/s | Loaded RSS | Peak RSS |
| ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 10,000 | 5/5 | `767927150f41a6967e99ab0e05f11128ba4f408f1b9bfc5e1fc753a84119ac8f` | 2103.781 | 4,753 ops/s | 177.89 MiB | 304.77 MiB |

## 10,000 objects

- Runs: 5/5 passed; fixture hash: `767927150f41a6967e99ab0e05f11128ba4f408f1b9bfc5e1fc753a84119ac8f`.
- Init: 1.616 ms; readiness: 1.141 ms; first object create: 6.877 ms.
- Bulk create/index: 2103.781 ms; 4,753 ops/s.
- Total independent run time: 32751.004 ms.
- Index entries/object: 17; indexing is synchronous and included in create time.
- Memory (idle / loaded / peak RSS): 62.23 MiB / 177.89 MiB / 304.77 MiB.
- Memory allocation: unknown% of system memory; requested / effective budget: n/a / n/a.
- Incremental memory/object: 12113.510 bytes RSS; incremental heap: 77.04 MiB.
- CPU: 33576.752 ms user + 399.062 ms system; 103.627% utilization.

| Operation | First ms | Warm min ms | Warm max ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| singleCreate | 0.595 | 0.234 | 0.446 | 0.293 | 0.274 | 0.394 | 0.446 | 3,373 ops/s |
| uuidRead | 0.173 | 0.016 | 0.068 | 0.026 | 0.023 | 0.050 | 0.068 | 35,132 ops/s |
| equality | 0.710 | 0.358 | 2.674 | 0.522 | 0.434 | 0.606 | 2.674 | 1,829 ops/s |
| nestedEquality | 0.712 | 0.322 | 1.096 | 0.537 | 0.507 | 0.579 | 1.096 | 1,783 ops/s |
| numericRange | 0.452 | 0.272 | 0.549 | 0.347 | 0.307 | 0.472 | 0.549 | 2,749 ops/s |
| and | 2.082 | 1.056 | 13.836 | 1.681 | 1.145 | 2.241 | 13.836 | 588 ops/s |
| or | 0.751 | 0.661 | 0.971 | 0.752 | 0.720 | 0.964 | 0.971 | 1,304 ops/s |
| singleKeyUpdate | 1.892 | 0.149 | 0.286 | 0.173 | 0.157 | 0.239 | 0.286 | 5,696 ops/s |
| indexedKeyUpdate | 0.689 | 0.162 | 0.317 | 0.196 | 0.173 | 0.296 | 0.317 | 5,049 ops/s |
| numericIncrement | 1.080 | 0.160 | 0.348 | 0.231 | 0.225 | 0.315 | 0.348 | 4,268 ops/s |
| singleDelete | 0.822 | 0.125 | 0.288 | 0.176 | 0.157 | 0.248 | 0.288 | 5,605 ops/s |

| Sustained mode | In-flight | ops/s | p50 ms | p95 ms | p99 ms | CPU utilization |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 121,485 ops/s | 0.006 | 0.010 | 0.023 | 103.294% |
| write | 1 | 8,364 ops/s | 0.102 | 0.167 | 0.210 | 106.263% |
| mixed | 1 | 15,134 ops/s | 0.098 | 0.152 | 0.189 | 105.353% |
| read | 8 | 174,245 ops/s | 0.025 | 0.042 | 0.064 | 99.965% |
| write | 8 | 9,337 ops/s | 0.464 | 0.861 | 1.143 | 101.482% |
| mixed | 8 | 17,023 ops/s | 0.293 | 0.491 | 0.658 | 100.967% |

| Run | Status | Failure / skip reason |
| ---: | --- | --- |
| - | all passed | - |

## Historical v2 lifecycle comparison

No v2 compatibility runs completed; historical results remain preserved in `providers/cocreatedb/results/summary.json` and `baselines/2026-11-19-final`.

| v2 metric | Historical summary | Current compatibility median |
| --- | ---: | ---: |
| n/a | retained only in the historical provider summary | n/a |

## Raw results and failures

Raw independent runs and the manifest are stored under `/home/ubuntu/Dev/CoCreateJS/modules/db/test/benchmarks/providers/cocreatedb/results/standard-2026-11-21T13-23-37.878Z`. Status counts: {"successfulRuns":5,"failedRuns":0,"notAttempted":0}. Provider summary appended to [summary.json](../summary.json) without replacing historical data.

## Limits and follow-up

This report measures a single-node CoCreateDB run with adaptive memory residency and local Warm writes. MongoDB and Redis have separate provider adapters and reports; compare their results by operation while accounting for transport, indexing and durability differences. Distributed synchronization, replication, sharding, external persistence durability, server/client separation, and transaction guarantees are out of scope.
