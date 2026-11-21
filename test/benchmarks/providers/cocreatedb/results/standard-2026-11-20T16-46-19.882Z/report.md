# CoCreateDB standardized benchmark results

- Run ID: `2026-11-20T16-46-19.882Z`; executed: 2026-11-20T16:46:19.882Z to 2026-11-20T16:51:58.227Z.
- Source revision: `3f3bb2f21f8fd2332b6f686bb50cfd8b1a553653`; DB version 1.0.0.
- Runtime: v24.18.0 / linux-x64; CPU: AMD EPYC 7571 (2 logical CPUs); RAM: 7838.21 MiB; limit: n/a.
- Method: 5 independent runs/size; 10 warmups and 40 samples per latency operation; 5000 ms sustained runs per workload/concurrency.
- Process model: single in-process Node process; benchmark client and database share CPU/RSS; durability: none; no disk or provider writes. Disk usage and I/O are not applicable.
- No competitor databases, containers, dependencies or datasets were installed or launched.

Each run is a fresh child process and database. Fixture data is generated in 1,000-record batches; object generation and fixture hashing are excluded from measured create/index time. The fixture hash is over the canonical pre-ingestion JSON dataset. Correctness checks compare UUID result sets before query timings are accepted. Measured request latency stops before result assertions. Sustained modes are read-only, increment-only writes, or alternating read/write calls; concurrency means outstanding in-process requests, not parallel database threads.

Initialization and readiness are reported separately. Index creation and maintenance are synchronous inside object creation, so create/index is one timed operation. The memory-only run has no disk I/O, persistence durability or network cost. CPU and RSS include both the benchmark client and database in the same Node process. Incremental memory/object is an approximate loaded-minus-idle RSS ratio.

| Size | Runs passed | Fixture hash | Create + index ms | Create ops/s | Loaded RSS | Peak RSS |
| ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 100,000 | 5/5 | `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b` | 4525.989 | 22,095 ops/s | 469.36 MiB | 583.30 MiB |

## 100,000 objects

- Runs: 5/5 passed; fixture hash: `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b`.
- Init: 1.304 ms; readiness: 0.981 ms; first object create: 6.241 ms.
- Bulk create/index: 4525.989 ms; 22,095 ops/s.
- Total independent run time: 37589.975 ms.
- Index entries/object: 17; indexing is synchronous and included in create time.
- Memory (idle / loaded / peak RSS): 63.83 MiB / 469.36 MiB / 583.30 MiB.
- Incremental memory/object: 4252.344 bytes RSS; incremental heap: 310.77 MiB.
- CPU: 38765.729 ms user + 618.572 ms system; 104.804% utilization.

| Operation | First ms | Warm min ms | Warm max ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| singleCreate | 0.284 | 0.062 | 0.110 | 0.067 | 0.065 | 0.090 | 0.110 | 14,592 ops/s |
| uuidRead | 0.183 | 0.020 | 0.082 | 0.029 | 0.026 | 0.036 | 0.082 | 32,178 ops/s |
| equality | 1.913 | 0.582 | 1.608 | 0.829 | 0.833 | 1.063 | 1.608 | 1,170 ops/s |
| nestedEquality | 3.733 | 2.433 | 4.273 | 3.086 | 2.872 | 3.627 | 4.273 | 322 ops/s |
| numericRange | 25.002 | 25.869 | 28.364 | 26.795 | 26.527 | 27.896 | 28.364 | 37 ops/s |
| and | 1.068 | 0.645 | 0.851 | 0.682 | 0.672 | 0.754 | 0.851 | 1,437 ops/s |
| or | 0.509 | 0.464 | 0.727 | 0.486 | 0.477 | 0.511 | 0.727 | 2,007 ops/s |
| singleKeyUpdate | 2.006 | 0.128 | 0.271 | 0.168 | 0.146 | 0.245 | 0.271 | 5,867 ops/s |
| indexedKeyUpdate | 0.331 | 0.124 | 0.281 | 0.152 | 0.128 | 0.249 | 0.281 | 6,490 ops/s |
| numericIncrement | 0.544 | 0.127 | 0.264 | 0.166 | 0.140 | 0.243 | 0.264 | 5,909 ops/s |
| singleDelete | 0.548 | 0.016 | 0.050 | 0.020 | 0.019 | 0.027 | 0.050 | 46,842 ops/s |

| Sustained mode | In-flight | ops/s | p50 ms | p95 ms | p99 ms | CPU utilization |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 128,008 ops/s | 0.006 | 0.009 | 0.016 | 104.319% |
| write | 1 | 9,718 ops/s | 0.092 | 0.134 | 0.164 | 105.645% |
| mixed | 1 | 17,531 ops/s | 0.090 | 0.120 | 0.147 | 102.417% |
| read | 8 | 173,305 ops/s | 0.025 | 0.042 | 0.062 | 100.075% |
| write | 8 | 10,635 ops/s | 0.426 | 0.731 | 0.798 | 101.517% |
| mixed | 8 | 18,933 ops/s | 0.274 | 0.419 | 0.500 | 101.389% |

| Run | Status | Failure / skip reason |
| ---: | --- | --- |
| - | all passed | - |

## Historical v2 lifecycle comparison

No v2 compatibility runs completed; historical results remain preserved in `providers/cocreatedb/results/summary.json` and `baselines/2026-11-19-final`.

| v2 metric | Historical summary | Current compatibility median |
| --- | ---: | ---: |
| n/a | retained only in the historical provider summary | n/a |

## Raw results and failures

Raw independent runs and the manifest are stored under `/home/ubuntu/Dev/CoCreateJS/modules/db/test/benchmarks/providers/cocreatedb/results/standard-2026-11-20T16-46-19.882Z`. Status counts: {"successfulRuns":5,"failedRuns":0,"notAttempted":0}. Provider summary appended to [cocreatedb.json](../summary.json) without replacing historical data.

## Limits and follow-up

This report measures the in-memory CoCreateDB prototype. MongoDB and Redis have separate provider adapters and reports; compare their results by operation while accounting for transport, indexing and durability differences. Distributed synchronization, replication, sharding, recovery, persistence durability, server/client separation, and transaction guarantees are out of scope for this in-memory CoCreateDB run.
