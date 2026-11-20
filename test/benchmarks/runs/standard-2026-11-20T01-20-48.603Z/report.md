# CoCreateDB standardized benchmark results

- Run ID: `2026-11-20T01-20-48.603Z`; executed: 2026-11-20T01:20:48.603Z to 2026-11-20T01:32:54.285Z.
- Source revision: `2955244dea8f32f0a7ebc16108239a82e721f58a`; DB version 1.0.0.
- Runtime: v24.18.0 / linux-x64; CPU: AMD EPYC 7571 (2 logical CPUs); RAM: 7838.21 MiB; limit: n/a.
- Method: 5 independent runs/size; 10 warmups and 40 samples per latency operation; 5000 ms sustained runs per workload/concurrency.
- Process model: single in-process Node process; benchmark client and database share CPU/RSS; durability: none; no disk or provider writes. Disk usage and I/O are not applicable.
- No competitor databases, containers, dependencies or datasets were installed or launched.

Each run is a fresh child process and database. Fixture data is generated in 1,000-record batches; object generation and fixture hashing are excluded from measured create/index time. The fixture hash is over the canonical pre-ingestion JSON dataset. Correctness checks compare UUID result sets before query timings are accepted. Measured request latency stops before result assertions. Sustained modes are read-only, increment-only writes, or alternating read/write calls; concurrency means outstanding in-process requests, not parallel database threads.

Initialization and readiness are reported separately. Index creation and maintenance are synchronous inside object creation, so create/index is one timed operation. The memory-only run has no disk I/O, persistence durability or network cost. CPU and RSS include both the benchmark client and database in the same Node process. Incremental memory/object is an approximate loaded-minus-idle RSS ratio.

| Size | Runs passed | Fixture hash | Create + index ms | Create ops/s | Loaded RSS | Peak RSS |
| ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 1,000 | 5/5 | `bc4f84465e1e80b84bf541e527e39516776dc4bc07afb233c45b825b29a846ac` | 316.824 | 3,156 ops/s | 86.48 MiB | 215.82 MiB |
| 10,000 | 5/5 | `767927150f41a6967e99ab0e05f11128ba4f408f1b9bfc5e1fc753a84119ac8f` | 3466.545 | 2,885 ops/s | 234.00 MiB | 287.61 MiB |
| 100,000 | 5/5 | `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b` | 47449.847 | 2,107 ops/s | 577.91 MiB | 654.32 MiB |

## 1,000 objects

- Runs: 5/5 passed; fixture hash: `bc4f84465e1e80b84bf541e527e39516776dc4bc07afb233c45b825b29a846ac`.
- Init: 1.084 ms; readiness: 0.968 ms; first object create: 5.898 ms.
- Bulk create/index: 316.824 ms; 3,156 ops/s.
- Total independent run time: 30755.702 ms.
- Index entries/object: 17; indexing is synchronous and included in create time.
- Memory (idle / loaded / peak RSS): 63.42 MiB / 86.48 MiB / 215.82 MiB.
- Incremental memory/object: 24088.576 bytes RSS; incremental heap: 9.15 MiB.
- CPU: 31363.219 ms user + 251.253 ms system; 102.805% utilization.

| Operation | First ms | Warm min ms | Warm max ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| singleCreate | 0.604 | 0.261 | 0.818 | 0.297 | 0.273 | 0.325 | 0.818 | 3,344 ops/s |
| uuidRead | 0.183 | 0.012 | 0.074 | 0.027 | 0.026 | 0.043 | 0.074 | 33,164 ops/s |
| equality | 0.375 | 0.173 | 1.529 | 0.285 | 0.257 | 0.321 | 1.529 | 3,038 ops/s |
| nestedEquality | 0.306 | 0.179 | 0.315 | 0.219 | 0.205 | 0.270 | 0.315 | 4,308 ops/s |
| numericRange | 0.250 | 0.137 | 1.092 | 0.220 | 0.187 | 0.285 | 1.092 | 4,236 ops/s |
| and | 0.897 | 0.531 | 1.457 | 0.815 | 0.840 | 1.010 | 1.457 | 1,200 ops/s |
| or | 0.425 | 0.365 | 0.771 | 0.404 | 0.386 | 0.448 | 0.771 | 2,405 ops/s |
| singleKeyUpdate | 1.897 | 0.141 | 0.246 | 0.162 | 0.145 | 0.229 | 0.246 | 6,087 ops/s |
| indexedKeyUpdate | 0.524 | 0.147 | 0.304 | 0.178 | 0.155 | 0.261 | 0.304 | 5,540 ops/s |
| numericIncrement | 0.579 | 0.150 | 0.308 | 0.225 | 0.232 | 0.291 | 0.308 | 4,394 ops/s |
| singleDelete | 0.511 | 0.105 | 0.259 | 0.154 | 0.147 | 0.211 | 0.259 | 6,402 ops/s |

| Sustained mode | In-flight | ops/s | p50 ms | p95 ms | p99 ms | CPU utilization |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 144,353 ops/s | 0.005 | 0.008 | 0.016 | 103.925% |
| write | 1 | 7,933 ops/s | 0.108 | 0.172 | 0.232 | 106.772% |
| mixed | 1 | 15,225 ops/s | 0.104 | 0.151 | 0.191 | 101.744% |
| read | 8 | 208,326 ops/s | 0.021 | 0.036 | 0.055 | 99.995% |
| write | 8 | 9,213 ops/s | 0.492 | 0.856 | 1.088 | 100.271% |
| mixed | 8 | 17,176 ops/s | 0.308 | 0.471 | 0.608 | 100.306% |

| Run | Status | Failure / skip reason |
| ---: | --- | --- |
| - | all passed | - |
## 10,000 objects

- Runs: 5/5 passed; fixture hash: `767927150f41a6967e99ab0e05f11128ba4f408f1b9bfc5e1fc753a84119ac8f`.
- Init: 1.102 ms; readiness: 1.002 ms; first object create: 5.987 ms.
- Bulk create/index: 3466.545 ms; 2,885 ops/s.
- Total independent run time: 34010.203 ms.
- Index entries/object: 17; indexing is synchronous and included in create time.
- Memory (idle / loaded / peak RSS): 63.57 MiB / 234.00 MiB / 287.61 MiB.
- Incremental memory/object: 17888.051 bytes RSS; incremental heap: 78.01 MiB.
- CPU: 35215.206 ms user + 323.096 ms system; 104.536% utilization.

| Operation | First ms | Warm min ms | Warm max ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| singleCreate | 0.786 | 0.352 | 0.546 | 0.382 | 0.376 | 0.410 | 0.546 | 2,597 ops/s |
| uuidRead | 0.241 | 0.012 | 0.058 | 0.023 | 0.018 | 0.035 | 0.058 | 39,988 ops/s |
| equality | 0.382 | 0.182 | 0.344 | 0.249 | 0.265 | 0.322 | 0.344 | 3,690 ops/s |
| nestedEquality | 0.533 | 0.228 | 0.523 | 0.309 | 0.327 | 0.413 | 0.523 | 3,054 ops/s |
| numericRange | 0.232 | 0.144 | 0.350 | 0.204 | 0.190 | 0.290 | 0.350 | 4,558 ops/s |
| and | 0.896 | 0.578 | 1.150 | 0.793 | 0.697 | 1.019 | 1.150 | 1,232 ops/s |
| or | 0.424 | 0.395 | 0.479 | 0.414 | 0.404 | 0.458 | 0.479 | 2,345 ops/s |
| singleKeyUpdate | 1.951 | 0.139 | 0.264 | 0.162 | 0.145 | 0.225 | 0.264 | 6,105 ops/s |
| indexedKeyUpdate | 0.596 | 0.157 | 0.341 | 0.195 | 0.168 | 0.299 | 0.341 | 5,051 ops/s |
| numericIncrement | 0.595 | 0.157 | 0.336 | 0.237 | 0.241 | 0.299 | 0.336 | 4,169 ops/s |
| singleDelete | 0.596 | 0.162 | 0.349 | 0.215 | 0.198 | 0.302 | 0.349 | 4,578 ops/s |

| Sustained mode | In-flight | ops/s | p50 ms | p95 ms | p99 ms | CPU utilization |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 132,979 ops/s | 0.006 | 0.009 | 0.018 | 103.728% |
| write | 1 | 7,242 ops/s | 0.122 | 0.179 | 0.227 | 107.868% |
| mixed | 1 | 13,372 ops/s | 0.117 | 0.166 | 0.202 | 104.768% |
| read | 8 | 184,076 ops/s | 0.023 | 0.039 | 0.058 | 100.016% |
| write | 8 | 8,082 ops/s | 0.557 | 0.961 | 1.180 | 101.074% |
| mixed | 8 | 15,113 ops/s | 0.344 | 0.530 | 0.689 | 101.169% |

| Run | Status | Failure / skip reason |
| ---: | --- | --- |
| - | all passed | - |
## 100,000 objects

- Runs: 5/5 passed; fixture hash: `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b`.
- Init: 1.076 ms; readiness: 0.973 ms; first object create: 5.909 ms.
- Bulk create/index: 47449.847 ms; 2,107 ops/s.
- Total independent run time: 78815.318 ms.
- Index entries/object: 17; indexing is synchronous and included in create time.
- Memory (idle / loaded / peak RSS): 63.59 MiB / 577.91 MiB / 654.32 MiB.
- Incremental memory/object: 5394.063 bytes RSS; incremental heap: 431.79 MiB.
- CPU: 80903.231 ms user + 894.979 ms system; 103.692% utilization.

| Operation | First ms | Warm min ms | Warm max ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| singleCreate | 1.183 | 0.587 | 0.968 | 0.691 | 0.627 | 0.827 | 0.968 | 1,440 ops/s |
| uuidRead | 0.195 | 0.016 | 0.074 | 0.027 | 0.026 | 0.049 | 0.074 | 29,792 ops/s |
| equality | 0.441 | 0.192 | 0.379 | 0.277 | 0.280 | 0.364 | 0.379 | 2,631 ops/s |
| nestedEquality | 0.565 | 0.239 | 1.964 | 0.387 | 0.272 | 0.413 | 1.964 | 2,358 ops/s |
| numericRange | 0.281 | 0.158 | 0.323 | 0.214 | 0.198 | 0.307 | 0.323 | 4,125 ops/s |
| and | 1.174 | 0.666 | 1.185 | 0.779 | 0.706 | 1.148 | 1.185 | 1,261 ops/s |
| or | 0.489 | 0.442 | 0.806 | 0.488 | 0.454 | 0.537 | 0.806 | 1,994 ops/s |
| singleKeyUpdate | 2.090 | 0.142 | 0.272 | 0.170 | 0.148 | 0.240 | 0.272 | 5,800 ops/s |
| indexedKeyUpdate | 0.729 | 0.178 | 0.357 | 0.224 | 0.199 | 0.320 | 0.357 | 4,405 ops/s |
| numericIncrement | 0.797 | 0.167 | 0.388 | 0.267 | 0.270 | 0.357 | 0.388 | 3,700 ops/s |
| singleDelete | 0.850 | 0.310 | 0.555 | 0.391 | 0.359 | 0.496 | 0.555 | 2,538 ops/s |

| Sustained mode | In-flight | ops/s | p50 ms | p95 ms | p99 ms | CPU utilization |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 128,250 ops/s | 0.006 | 0.009 | 0.018 | 104.159% |
| write | 1 | 6,624 ops/s | 0.136 | 0.200 | 0.244 | 106.951% |
| mixed | 1 | 12,755 ops/s | 0.125 | 0.172 | 0.206 | 102.222% |
| read | 8 | 172,755 ops/s | 0.025 | 0.042 | 0.062 | 100.011% |
| write | 8 | 7,409 ops/s | 0.604 | 1.047 | 1.343 | 101.244% |
| mixed | 8 | 13,866 ops/s | 0.373 | 0.576 | 0.751 | 101.219% |

| Run | Status | Failure / skip reason |
| ---: | --- | --- |
| - | all passed | - |

## Historical v2 lifecycle comparison

The retained historical baseline and the current compatibility lane both use fixture v2 hash `25ebce8889cb93e29279301a3681ce66ebe80d5cb0d147387455ad5cddb44e48` / `25ebce8889cb93e29279301a3681ce66ebe80d5cb0d147387455ad5cddb44e48`. Historical: 22.16.0, 4 CPUs, 40 samples, 5 independent runs. Current compatibility: v24.18.0, 2 reported CPUs, 40 samples, 5 independent runs. The datasets and lifecycle query/update operations are equivalent, but runtime and hardware metadata differ, so this is a historical comparison rather than a controlled same-host comparison.

| v2 metric | Historical summary | Current compatibility median |
| --- | ---: | ---: |
| Create + index ms | 119.279 | 220.215 |
| UUID read p50 ms | 0.004 | 0.026 |
| Equality p50 ms | 0.206 | 0.284 |
| Nested equality p50 ms | 0.278 | 0.191 |
| Range p50 ms | 0.358 | 0.506 |
| Update p50 ms | 0.032 | 0.173 |
| Heap used | 11.51 MiB | 17.56 MiB |
| RSS | 45.29 MiB | 84.27 MiB |

## Raw results and failures

Raw independent runs and the manifest are stored under `/home/ubuntu/Dev/CoCreateJS/modules/db/test/benchmarks/runs/standard-2026-11-20T01-20-48.603Z`. Status counts: {"successfulRuns":15,"failedRuns":0,"notAttempted":0}. Provider summary appended to [cocreatedb.json](../providers/cocreatedb.json) without replacing historical data.

## Limits and follow-up

This phase measures the in-memory CoCreateDB prototype only. No MongoDB, Redis, Couchbase, CouchDB or CockroachDB adapters are included until each provider is run under this methodology. Results from historical MongoDB/Redis references are not ranked against these measurements. Distributed synchronization, replication, sharding, recovery, persistence durability, server/client separation, and transaction guarantees are out of scope.
