# CoCreateDB standardized benchmark results

- Run ID: `2026-11-20T06-10-08.681Z`; executed: 2026-11-20T06:10:08.681Z to 2026-11-20T06:22:12.792Z.
- Source revision: `4dccde14ba2f645043954617648d7a75be326dfa`; DB version 1.0.0.
- Runtime: v24.18.0 / linux-x64; CPU: AMD EPYC 7571 (2 logical CPUs); RAM: 7838.21 MiB; limit: n/a.
- Method: 5 independent runs/size; 10 warmups and 40 samples per latency operation; 5000 ms sustained runs per workload/concurrency.
- Process model: single in-process Node process; benchmark client and database share CPU/RSS; durability: none; no disk or provider writes. Disk usage and I/O are not applicable.
- No competitor databases, containers, dependencies or datasets were installed or launched.

Each run is a fresh child process and database. Fixture data is generated in 1,000-record batches; object generation and fixture hashing are excluded from measured create/index time. The fixture hash is over the canonical pre-ingestion JSON dataset. Correctness checks compare UUID result sets before query timings are accepted. Measured request latency stops before result assertions. Sustained modes are read-only, increment-only writes, or alternating read/write calls; concurrency means outstanding in-process requests, not parallel database threads.

Initialization and readiness are reported separately. Index creation and maintenance are synchronous inside object creation, so create/index is one timed operation. The memory-only run has no disk I/O, persistence durability or network cost. CPU and RSS include both the benchmark client and database in the same Node process. Incremental memory/object is an approximate loaded-minus-idle RSS ratio.

| Size | Runs passed | Fixture hash | Create + index ms | Create ops/s | Loaded RSS | Peak RSS |
| ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 1,000 | 5/5 | `bc4f84465e1e80b84bf541e527e39516776dc4bc07afb233c45b825b29a846ac` | 317.416 | 3,150 ops/s | 85.45 MiB | 212.04 MiB |
| 10,000 | 5/5 | `767927150f41a6967e99ab0e05f11128ba4f408f1b9bfc5e1fc753a84119ac8f` | 3572.970 | 2,799 ops/s | 203.39 MiB | 286.50 MiB |
| 100,000 | 5/5 | `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b` | 47243.970 | 2,117 ops/s | 574.22 MiB | 648.53 MiB |

## 1,000 objects

- Runs: 5/5 passed; fixture hash: `bc4f84465e1e80b84bf541e527e39516776dc4bc07afb233c45b825b29a846ac`.
- Init: 1.095 ms; readiness: 0.958 ms; first object create: 6.025 ms.
- Bulk create/index: 317.416 ms; 3,150 ops/s.
- Total independent run time: 30774.001 ms.
- Index entries/object: 17; indexing is synchronous and included in create time.
- Memory (idle / loaded / peak RSS): 63.61 MiB / 85.45 MiB / 212.04 MiB.
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
## 10,000 objects

- Runs: 5/5 passed; fixture hash: `767927150f41a6967e99ab0e05f11128ba4f408f1b9bfc5e1fc753a84119ac8f`.
- Init: 1.091 ms; readiness: 0.973 ms; first object create: 5.996 ms.
- Bulk create/index: 3572.970 ms; 2,799 ops/s.
- Total independent run time: 34161.355 ms.
- Index entries/object: 17; indexing is synchronous and included in create time.
- Memory (idle / loaded / peak RSS): 63.48 MiB / 203.39 MiB / 286.50 MiB.
- Incremental memory/object: 14671.462 bytes RSS; incremental heap: 56.11 MiB.
- CPU: 35275.286 ms user + 372.970 ms system; 104.359% utilization.

| Operation | First ms | Warm min ms | Warm max ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| singleCreate | 0.882 | 0.438 | 0.536 | 0.470 | 0.464 | 0.502 | 0.536 | 2,112 ops/s |
| uuidRead | 0.192 | 0.016 | 0.074 | 0.030 | 0.027 | 0.043 | 0.074 | 31,023 ops/s |
| equality | 0.409 | 0.190 | 0.366 | 0.265 | 0.281 | 0.349 | 0.366 | 3,457 ops/s |
| nestedEquality | 0.504 | 0.290 | 0.809 | 0.436 | 0.365 | 0.521 | 0.809 | 2,191 ops/s |
| numericRange | 0.449 | 0.163 | 0.346 | 0.215 | 0.181 | 0.323 | 0.346 | 4,363 ops/s |
| and | 0.952 | 0.847 | 1.387 | 1.039 | 0.923 | 1.367 | 1.387 | 944 ops/s |
| or | 0.634 | 0.583 | 0.764 | 0.613 | 0.606 | 0.646 | 0.764 | 1,596 ops/s |
| singleKeyUpdate | 2.110 | 0.175 | 0.332 | 0.203 | 0.183 | 0.283 | 0.332 | 4,854 ops/s |
| indexedKeyUpdate | 0.702 | 0.193 | 0.418 | 0.234 | 0.210 | 0.327 | 0.418 | 4,226 ops/s |
| numericIncrement | 0.636 | 0.181 | 0.398 | 0.265 | 0.261 | 0.358 | 0.398 | 3,722 ops/s |
| singleDelete | 0.579 | 0.154 | 0.317 | 0.208 | 0.187 | 0.292 | 0.317 | 4,762 ops/s |

| Sustained mode | In-flight | ops/s | p50 ms | p95 ms | p99 ms | CPU utilization |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 134,494 ops/s | 0.006 | 0.009 | 0.019 | 103.847% |
| write | 1 | 7,018 ops/s | 0.125 | 0.190 | 0.232 | 107.741% |
| mixed | 1 | 13,254 ops/s | 0.120 | 0.162 | 0.203 | 105.385% |
| read | 8 | 188,299 ops/s | 0.023 | 0.038 | 0.057 | 100.018% |
| write | 8 | 7,913 ops/s | 0.571 | 0.983 | 1.190 | 101.093% |
| mixed | 8 | 14,582 ops/s | 0.356 | 0.547 | 0.673 | 101.179% |

| Run | Status | Failure / skip reason |
| ---: | --- | --- |
| - | all passed | - |
## 100,000 objects

- Runs: 5/5 passed; fixture hash: `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b`.
- Init: 1.131 ms; readiness: 0.961 ms; first object create: 6.123 ms.
- Bulk create/index: 47243.970 ms; 2,117 ops/s.
- Total independent run time: 78690.494 ms.
- Index entries/object: 17; indexing is synchronous and included in create time.
- Memory (idle / loaded / peak RSS): 63.64 MiB / 574.22 MiB / 648.53 MiB.
- Incremental memory/object: 5353.677 bytes RSS; incremental heap: 404.23 MiB.
- CPU: 81154.431 ms user + 961.530 ms system; 104.232% utilization.

| Operation | First ms | Warm min ms | Warm max ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| singleCreate | 1.232 | 0.564 | 0.669 | 0.607 | 0.605 | 0.656 | 0.669 | 1,639 ops/s |
| uuidRead | 0.200 | 0.011 | 0.070 | 0.023 | 0.019 | 0.054 | 0.070 | 37,775 ops/s |
| equality | 0.399 | 0.189 | 0.360 | 0.274 | 0.286 | 0.336 | 0.360 | 3,361 ops/s |
| nestedEquality | 0.476 | 0.233 | 0.595 | 0.382 | 0.363 | 0.437 | 0.595 | 2,482 ops/s |
| numericRange | 0.375 | 0.175 | 0.365 | 0.230 | 0.207 | 0.328 | 0.365 | 4,082 ops/s |
| and | 1.202 | 0.699 | 1.291 | 0.830 | 0.745 | 1.120 | 1.291 | 1,184 ops/s |
| or | 0.540 | 0.479 | 0.549 | 0.502 | 0.496 | 0.529 | 0.549 | 1,942 ops/s |
| singleKeyUpdate | 2.089 | 0.145 | 0.383 | 0.184 | 0.152 | 0.264 | 0.383 | 5,358 ops/s |
| indexedKeyUpdate | 0.700 | 0.180 | 0.383 | 0.225 | 0.197 | 0.325 | 0.383 | 4,381 ops/s |
| numericIncrement | 0.810 | 0.166 | 0.379 | 0.255 | 0.264 | 0.346 | 0.379 | 3,865 ops/s |
| singleDelete | 0.764 | 0.303 | 0.518 | 0.360 | 0.337 | 0.499 | 0.518 | 2,757 ops/s |

| Sustained mode | In-flight | ops/s | p50 ms | p95 ms | p99 ms | CPU utilization |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 128,145 ops/s | 0.006 | 0.009 | 0.016 | 104.059% |
| write | 1 | 6,569 ops/s | 0.138 | 0.199 | 0.254 | 107.458% |
| mixed | 1 | 12,788 ops/s | 0.127 | 0.164 | 0.198 | 102.339% |
| read | 8 | 172,700 ops/s | 0.025 | 0.042 | 0.060 | 100.089% |
| write | 8 | 7,406 ops/s | 0.609 | 1.046 | 1.213 | 101.266% |
| mixed | 8 | 13,936 ops/s | 0.376 | 0.572 | 0.637 | 101.208% |

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

Raw independent runs and the manifest are stored under `/home/ubuntu/Dev/CoCreateJS/modules/db/test/benchmarks/providers/cocreatedb/results/standard-2026-11-20T06-10-08.681Z`. Status counts: {"successfulRuns":15,"failedRuns":0,"notAttempted":0}. Provider summary appended to [cocreatedb.json](../summary.json) without replacing historical data.

## Limits and follow-up

This report measures the in-memory CoCreateDB prototype. MongoDB and Redis have separate provider adapters and reports; compare their results by operation while accounting for transport, indexing and durability differences. Distributed synchronization, replication, sharding, recovery, persistence durability, server/client separation, and transaction guarantees are out of scope for this in-memory CoCreateDB run.
