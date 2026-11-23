# CoCreateDB standardized benchmark results

- Run ID: `2026-11-23T18-52-26.061Z`; executed: 2026-11-23T18:52:26.061Z to 2026-11-23T19:07:04.683Z.
- Source revision: `fbd2950c861b8481780653c9fb26caea41f4f2f2`; DB version 1.1.0.
- Runtime: v24.18.0 / linux-x64; CPU: AMD EPYC 7571 (2 logical CPUs); RAM: 7838.21 MiB; limit: n/a.
- Method: 5 independent runs/size; 10 warmups and 40 samples per latency operation; 5000 ms sustained runs per workload/concurrency.
- Process model: single in-process Node process; benchmark client and database share CPU/RSS; mode: adaptive; acknowledgement: memory; memory allocation: 75%. local writes are queued after memory acknowledgement; disk drain excluded from request timings.
- No competitor databases, containers, dependencies or datasets were installed or launched.

Each run is a fresh child process and database. Fixture data is generated in 1,000-record batches; object generation and fixture hashing are excluded from measured create/index time. The fixture hash is over the canonical pre-ingestion JSON dataset. Correctness checks compare UUID result sets before query timings are accepted. Measured request latency stops before result assertions. Sustained modes are read-only, increment-only writes, or alternating read/write calls; concurrency means outstanding in-process requests, not parallel database threads.

Initialization and readiness are reported separately. Index creation and maintenance are synchronous inside object creation, so create/index is one timed operation. Local Warm writes are queued after memory acknowledgement; their disk drain is not included in request timings. External persistence is not configured. CPU and RSS include both the benchmark client and database in the same Node process. Incremental memory/object is an approximate loaded-minus-idle RSS ratio.

| Size | Runs passed | Fixture hash | Create + index ms | Create ops/s | Loaded RSS | Peak RSS |
| ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 100,000 | 5/5 | `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b` | 78676.339 | 1,271 ops/s | 674.79 MiB | 851.90 MiB |

## 100,000 objects

- Runs: 5/5 passed; fixture hash: `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b`.
- Init: 5.776 ms; readiness: 1.689 ms; first object create: 10.398 ms.
- Bulk create/index: 78676.339 ms; 1,271 ops/s.
- Total independent run time: 111230.172 ms.
- Index entries/object: 17; indexing is synchronous and included in create time.
- Memory (idle / loaded / peak RSS): 62.55 MiB / 674.79 MiB / 851.90 MiB.
- Memory allocation: 75% of system memory; requested / effective budget: n/a / n/a.
- Incremental memory/object: 6421.258 bytes RSS; incremental heap: 529.39 MiB.
- CPU: 107146.361 ms user + 22453.040 ms system; 116.314% utilization.

| Operation | First ms | Warm min ms | Warm max ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| singleCreate | 3.705 | 0.865 | 2.539 | 1.173 | 1.032 | 1.697 | 2.539 | 849 ops/s |
| uuidRead | 0.242 | 0.026 | 0.101 | 0.049 | 0.045 | 0.085 | 0.101 | 19,480 ops/s |
| equality | 1.592 | 0.802 | 8.538 | 1.306 | 1.095 | 1.588 | 8.538 | 750 ops/s |
| nestedEquality | 1.422 | 0.695 | 3.135 | 1.098 | 1.008 | 1.742 | 3.135 | 893 ops/s |
| numericRange | 1.246 | 0.675 | 1.507 | 0.983 | 0.925 | 1.485 | 1.507 | 998 ops/s |
| and | 8.838 | 5.708 | 7.603 | 6.147 | 6.009 | 7.181 | 7.603 | 162 ops/s |
| or | 3.843 | 2.917 | 4.612 | 3.210 | 3.098 | 3.661 | 4.612 | 309 ops/s |
| singleKeyUpdate | 2.885 | 0.198 | 1.306 | 0.281 | 0.234 | 0.357 | 1.306 | 3,522 ops/s |
| indexedKeyUpdate | 1.037 | 0.197 | 0.459 | 0.253 | 0.217 | 0.371 | 0.459 | 3,914 ops/s |
| numericIncrement | 1.649 | 0.194 | 0.387 | 0.264 | 0.267 | 0.352 | 0.387 | 3,746 ops/s |
| singleDelete | 1.396 | 0.420 | 1.048 | 0.553 | 0.491 | 0.728 | 1.048 | 1,795 ops/s |

| Sustained mode | In-flight | ops/s | p50 ms | p95 ms | p99 ms | CPU utilization |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 69,006 ops/s | 0.011 | 0.018 | 0.036 | 104.882% |
| write | 1 | 5,785 ops/s | 0.152 | 0.228 | 0.297 | 108.834% |
| mixed | 1 | 10,952 ops/s | 0.135 | 0.189 | 0.249 | 102.555% |
| read | 8 | 86,290 ops/s | 0.053 | 0.093 | 0.138 | 100.140% |
| write | 8 | 6,553 ops/s | 0.687 | 1.185 | 1.439 | 101.643% |
| mixed | 8 | 11,799 ops/s | 0.331 | 0.648 | 0.817 | 101.418% |

| Run | Status | Failure / skip reason |
| ---: | --- | --- |
| - | all passed | - |

## Historical v2 lifecycle comparison

No v2 compatibility runs completed; historical results remain preserved in `providers/cocreatedb/results/summary.json` and `baselines/2026-11-19-final`.

| v2 metric | Historical summary | Current compatibility median |
| --- | ---: | ---: |
| n/a | retained only in the historical provider summary | n/a |

## Raw results and failures

Raw independent runs and the manifest are stored under `/home/ubuntu/Dev/CoCreateJS/modules/db/test/benchmarks/providers/cocreatedb/results/standard-async-refactor-2026-11-23-coalesced`. Status counts: {"successfulRuns":5,"failedRuns":0,"notAttempted":0}. Provider summary appended to [summary.json](../summary.json) without replacing historical data.

## Limits and follow-up

This report measures a single-node CoCreateDB run with adaptive memory residency and local Warm writes. MongoDB and Redis have separate provider adapters and reports; compare their results by operation while accounting for transport, indexing and durability differences. Distributed synchronization, replication, sharding, external persistence durability, server/client separation, and transaction guarantees are out of scope.
