# CoCreateDB standardized benchmark results

- Run ID: `2026-11-20T06-10-08.681Z`; executed: 2026-11-20T06:10:08.681Z to 2026-11-20T06:22:12.792Z.
- Source revision: `4dccde14ba2f645043954617648d7a75be326dfa`; DB version 1.0.0.
- Runtime: v24.18.0 / linux-x64; CPU: AMD EPYC 7571 (2 logical CPUs); RAM: 7838.21 MiB; limit: n/a.
- Method: 5 independent runs/size; 10 warmups and 40 samples per latency operation; 5000 ms sustained runs per workload/concurrency.
- Process model: single in-process Node process; benchmark client and database share CPU/RSS; mode: adaptive; acknowledgement: memory; memory allocation: unknown%. none; no disk or provider writes.
- No competitor databases, containers, dependencies or datasets were installed or launched.

Each run is a fresh child process and database. Fixture data is generated in 1,000-record batches; object generation and fixture hashing are excluded from measured create/index time. The fixture hash is over the canonical pre-ingestion JSON dataset. Correctness checks compare UUID result sets before query timings are accepted. Measured request latency stops before result assertions. Sustained modes are read-only, increment-only writes, or alternating read/write calls; concurrency means outstanding in-process requests, not parallel database threads.

Initialization and readiness are reported separately. Index creation and maintenance are synchronous inside object creation, so create/index is one timed operation. Local Warm writes are queued after memory acknowledgement; their disk drain is not included in request timings. External persistence is not configured. CPU and RSS include both the benchmark client and database in the same Node process. Incremental memory/object is an approximate loaded-minus-idle RSS ratio.

| Size | Runs passed | Fixture hash | Create + index ms | Create ops/s | Loaded RSS | Peak RSS |
| ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 1,000 | 5/5 | `bc4f84465e1e80b84bf541e527e39516776dc4bc07afb233c45b825b29a846ac` | 317.416 | 3,150 ops/s | 85.45 MiB | 212.04 MiB |

## 1,000 objects

- Runs: 5/5 passed; fixture hash: `bc4f84465e1e80b84bf541e527e39516776dc4bc07afb233c45b825b29a846ac`.
- Init: 1.095 ms; readiness: 0.958 ms; first object create: 6.025 ms.
- Bulk create/index: 317.416 ms; 3,150 ops/s.
- Total independent run time: 30774.001 ms.
- Index entries/object: 17; indexing is synchronous and included in create time.
- Memory (idle / loaded / peak RSS): 63.61 MiB / 85.45 MiB / 212.04 MiB.
- Memory allocation: unknown% of system memory; requested / effective budget: n/a / n/a.
- Incremental memory/object: 22900.736 bytes RSS; incremental heap: 9.01 MiB.
- CPU: 31357.282 ms user + 286.218 ms system; 102.898% utilization.

| Operation | First ms | Warm min ms | Warm max ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| singleCreate | 0.635 | 0.267 | 0.875 | 0.303 | 0.280 | 0.361 | 0.875 | 3,271 ops/s |
| uuidRead | 0.183 | 0.017 | 0.067 | 0.031 | 0.029 | 0.054 | 0.067 | 29,491 ops/s |
| equality | 0.386 | 0.181 | 1.854 | 0.305 | 0.270 | 0.340 | 1.854 | 2,641 ops/s |
| nestedEquality | 0.544 | 0.179 | 0.688 | 0.219 | 0.199 | 0.292 | 0.688 | 4,326 ops/s |
| numericRange | 0.427 | 0.159 | 1.557 | 0.312 | 0.248 | 0.339 | 1.557 | 3,030 ops/s |
| and | 0.950 | 0.590 | 2.261 | 0.874 | 0.801 | 1.108 | 2.261 | 1,122 ops/s |
| or | 0.443 | 0.413 | 0.616 | 0.443 | 0.431 | 0.470 | 0.616 | 2,195 ops/s |
| singleKeyUpdate | 2.044 | 0.142 | 0.283 | 0.166 | 0.150 | 0.238 | 0.283 | 5,932 ops/s |
| indexedKeyUpdate | 0.529 | 0.151 | 0.314 | 0.183 | 0.158 | 0.268 | 0.314 | 5,388 ops/s |
| numericIncrement | 0.567 | 0.153 | 0.302 | 0.227 | 0.235 | 0.288 | 0.302 | 4,353 ops/s |
| singleDelete | 0.509 | 0.106 | 0.266 | 0.153 | 0.141 | 0.213 | 0.266 | 6,433 ops/s |

| Sustained mode | In-flight | ops/s | p50 ms | p95 ms | p99 ms | CPU utilization |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 142,624 ops/s | 0.005 | 0.008 | 0.018 | 103.688% |
| write | 1 | 7,709 ops/s | 0.111 | 0.179 | 0.235 | 107.091% |
| mixed | 1 | 15,247 ops/s | 0.106 | 0.147 | 0.172 | 101.673% |
| read | 8 | 210,145 ops/s | 0.021 | 0.034 | 0.051 | 100.086% |
| write | 8 | 8,870 ops/s | 0.503 | 0.883 | 1.168 | 100.223% |
| mixed | 8 | 16,849 ops/s | 0.313 | 0.481 | 0.611 | 100.250% |

| Run | Status | Failure / skip reason |
| ---: | --- | --- |
| - | all passed | - |

## Historical v2 lifecycle comparison

The retained historical baseline and the current compatibility lane both use fixture v2 hash `25ebce8889cb93e29279301a3681ce66ebe80d5cb0d147387455ad5cddb44e48` / `25ebce8889cb93e29279301a3681ce66ebe80d5cb0d147387455ad5cddb44e48`. Historical: 22.16.0, 4 CPUs, 40 samples, 5 independent runs. Current compatibility: v24.18.0, 2 reported CPUs, 40 samples, 5 independent runs. The datasets and lifecycle query/update operations are equivalent, but runtime and hardware metadata differ, so this is a historical comparison rather than a controlled same-host comparison.

| v2 metric | Historical summary | Current compatibility median |
| --- | ---: | ---: |
| Create + index ms | 119.279 | 216.151 |
| UUID read p50 ms | 0.004 | 0.027 |
| Equality p50 ms | 0.206 | 0.288 |
| Nested equality p50 ms | 0.278 | 0.163 |
| Range p50 ms | 0.358 | 0.520 |
| Update p50 ms | 0.032 | 0.178 |
| Heap used | 11.51 MiB | 18.13 MiB |
| RSS | 45.29 MiB | 85.26 MiB |

## Raw results and failures

Raw independent runs and the manifest are stored under `/home/ubuntu/Dev/CoCreateJS/modules/db/test/benchmarks/providers/cocreatedb/results/standard-2026-11-20T06-10-08.681Z`. Status counts: {"successfulRuns":5,"failedRuns":0,"notAttempted":0}. Provider summary appended to [summary.json](../summary.json) without replacing historical data.

## Limits and follow-up

This report measures a single-node CoCreateDB run with adaptive memory residency and local Warm writes. MongoDB and Redis have separate provider adapters and reports; compare their results by operation while accounting for transport, indexing and durability differences. Distributed synchronization, replication, sharding, external persistence durability, server/client separation, and transaction guarantees are out of scope.
