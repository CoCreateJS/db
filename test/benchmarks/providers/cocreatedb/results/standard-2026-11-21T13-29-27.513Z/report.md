# CoCreateDB standardized benchmark results

- Run ID: `2026-11-21T13-29-27.513Z`; executed: 2026-11-21T13:29:27.513Z to 2026-11-21T13:34:32.458Z.
- Source revision: `7d9c347d0385de84d9aefa6acbb00dafec9edaa7`; DB version 1.0.0.
- Runtime: v24.18.0 / linux-x64; CPU: AMD EPYC 7571 (2 logical CPUs); RAM: 7838.21 MiB; limit: n/a.
- Method: 5 independent runs/size; 10 warmups and 40 samples per latency operation; 5000 ms sustained runs per workload/concurrency.
- Process model: single in-process Node process; benchmark client and database share CPU/RSS; durability: none; no disk or provider writes. Disk usage and I/O are not applicable.
- No competitor databases, containers, dependencies or datasets were installed or launched.

Each run is a fresh child process and database. Fixture data is generated in 1,000-record batches; object generation and fixture hashing are excluded from measured create/index time. The fixture hash is over the canonical pre-ingestion JSON dataset. Correctness checks compare UUID result sets before query timings are accepted. Measured request latency stops before result assertions. Sustained modes are read-only, increment-only writes, or alternating read/write calls; concurrency means outstanding in-process requests, not parallel database threads.

Initialization and readiness are reported separately. Index creation and maintenance are synchronous inside object creation, so create/index is one timed operation. The memory-only run has no disk I/O, persistence durability or network cost. CPU and RSS include both the benchmark client and database in the same Node process. Incremental memory/object is an approximate loaded-minus-idle RSS ratio.

| Size | Runs passed | Fixture hash | Create + index ms | Create ops/s | Loaded RSS | Peak RSS |
| ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 100,000 | 5/5 | `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b` | 28991.891 | 3,449 ops/s | 640.32 MiB | 719.81 MiB |

## 100,000 objects

- Runs: 5/5 passed; fixture hash: `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b`.
- Init: 1.427 ms; readiness: 1.123 ms; first object create: 6.800 ms.
- Bulk create/index: 28991.891 ms; 3,449 ops/s.
- Total independent run time: 60822.009 ms.
- Index entries/object: 17; indexing is synchronous and included in create time.
- Memory (idle / loaded / peak RSS): 62.37 MiB / 640.32 MiB / 719.81 MiB.
- Incremental memory/object: 6061.629 bytes RSS; incremental heap: 473.68 MiB.
- CPU: 63077.008 ms user + 976.738 ms system; 105.388% utilization.

| Operation | First ms | Warm min ms | Warm max ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| singleCreate | 1.037 | 0.326 | 0.559 | 0.390 | 0.377 | 0.503 | 0.559 | 2,548 ops/s |
| uuidRead | 0.189 | 0.012 | 0.097 | 0.024 | 0.021 | 0.051 | 0.097 | 36,847 ops/s |
| equality | 0.652 | 0.291 | 0.529 | 0.396 | 0.405 | 0.491 | 0.529 | 2,379 ops/s |
| nestedEquality | 0.718 | 0.386 | 0.641 | 0.444 | 0.414 | 0.518 | 0.641 | 2,137 ops/s |
| numericRange | 0.546 | 0.205 | 0.764 | 0.277 | 0.255 | 0.398 | 0.764 | 3,402 ops/s |
| and | 2.253 | 1.242 | 2.163 | 1.528 | 1.389 | 1.796 | 2.163 | 647 ops/s |
| or | 0.845 | 0.736 | 1.094 | 0.813 | 0.780 | 0.939 | 1.094 | 1,209 ops/s |
| singleKeyUpdate | 1.835 | 0.123 | 0.243 | 0.151 | 0.130 | 0.224 | 0.243 | 6,532 ops/s |
| indexedKeyUpdate | 0.739 | 0.145 | 0.312 | 0.178 | 0.155 | 0.288 | 0.312 | 5,537 ops/s |
| numericIncrement | 1.130 | 0.146 | 0.300 | 0.202 | 0.198 | 0.274 | 0.300 | 4,887 ops/s |
| singleDelete | 0.906 | 0.194 | 0.401 | 0.255 | 0.230 | 0.345 | 0.401 | 3,880 ops/s |

| Sustained mode | In-flight | ops/s | p50 ms | p95 ms | p99 ms | CPU utilization |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 119,002 ops/s | 0.006 | 0.010 | 0.019 | 103.821% |
| write | 1 | 6,825 ops/s | 0.113 | 0.182 | 0.257 | 115.536% |
| mixed | 1 | 14,493 ops/s | 0.104 | 0.158 | 0.199 | 102.221% |
| read | 8 | 162,376 ops/s | 0.027 | 0.046 | 0.070 | 100.567% |
| write | 8 | 8,679 ops/s | 0.499 | 0.913 | 1.191 | 101.158% |
| mixed | 8 | 16,145 ops/s | 0.308 | 0.505 | 0.668 | 101.328% |

| Run | Status | Failure / skip reason |
| ---: | --- | --- |
| - | all passed | - |

## Historical v2 lifecycle comparison

No v2 compatibility runs completed; historical results remain preserved in `providers/cocreatedb/results/summary.json` and `baselines/2026-11-19-final`.

| v2 metric | Historical summary | Current compatibility median |
| --- | ---: | ---: |
| n/a | retained only in the historical provider summary | n/a |

## Raw results and failures

Raw independent runs and the manifest are stored under `/home/ubuntu/Dev/CoCreateJS/modules/db/test/benchmarks/providers/cocreatedb/results/standard-2026-11-21T13-29-27.513Z`. Status counts: {"successfulRuns":5,"failedRuns":0,"notAttempted":0}. Provider summary appended to [summary.json](../summary.json) without replacing historical data.

## Limits and follow-up

This report measures the in-memory CoCreateDB prototype. MongoDB and Redis have separate provider adapters and reports; compare their results by operation while accounting for transport, indexing and durability differences. Distributed synchronization, replication, sharding, recovery, persistence durability, server/client separation, and transaction guarantees are out of scope for this in-memory CoCreateDB run.
