# CoCreateDB standardized benchmark results

- Run ID: `2026-11-20T01-04-18.943Z`; executed: 2026-11-20T01:04:18.943Z to 2026-11-20T01:17:40.000Z.
- Source revision: `2955244dea8f32f0a7ebc16108239a82e721f58a`; DB version 1.0.0.
- Runtime: v24.18.0 / linux-x64; CPU: AMD EPYC 7571 (2 logical CPUs); RAM: 7838.21 MiB; limit: n/a.
- Method: 5 independent runs/size; 10 warmups and 40 samples per latency operation; 1000 ms sustained runs per workload/concurrency.
- Process model: single in-process Node process; benchmark client and database share CPU/RSS; durability: none; no disk or provider writes. Disk usage and I/O are not applicable.
- No competitor databases, containers, dependencies or datasets were installed or launched.

Each run is a fresh child process and database. Fixture data is generated in 1,000-record batches; object generation and fixture hashing are excluded from measured create/index time. The fixture hash is over the canonical pre-ingestion JSON dataset. Correctness checks compare UUID result sets before query timings are accepted. Measured request latency stops before result assertions. Sustained modes are read-only, increment-only writes, or alternating read/write calls; concurrency means outstanding in-process requests, not parallel database threads.

Initialization and readiness are reported separately. Index creation and maintenance are synchronous inside object creation, so create/index is one timed operation. The memory-only run has no disk I/O, persistence durability or network cost. CPU and RSS include both the benchmark client and database in the same Node process. Incremental memory/object is an approximate loaded-minus-idle RSS ratio.

| Size | Runs passed | Fixture hash | Create + index ms | Create ops/s | Loaded RSS | Peak RSS |
| ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 1,000 | 5/5 | `bc4f84465e1e80b84bf541e527e39516776dc4bc07afb233c45b825b29a846ac` | 306.230 | 3,266 ops/s | 84.68 MiB | 145.96 MiB |
| 10,000 | 5/5 | `767927150f41a6967e99ab0e05f11128ba4f408f1b9bfc5e1fc753a84119ac8f` | 3393.594 | 2,947 ops/s | 233.64 MiB | 255.70 MiB |
| 100,000 | 5/5 | `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b` | 45318.659 | 2,207 ops/s | 574.81 MiB | 595.77 MiB |
| 1,000,000 | 0/5 | `n/a` | n/a | n/a | n/a | n/a |

## 1,000 objects

- Runs: 5/5 passed; fixture hash: `bc4f84465e1e80b84bf541e527e39516776dc4bc07afb233c45b825b29a846ac`.
- Init: 1.132 ms; readiness: 1.013 ms; first object create: 5.848 ms.
- Bulk create/index: 306.230 ms; 3,266 ops/s.
- Total independent run time: 6681.717 ms.
- Index entries/object: 17; indexing is synchronous and included in create time.
- Memory (idle / loaded / peak RSS): 62.45 MiB / 84.68 MiB / 145.96 MiB.
- Incremental memory/object: 23601.152 bytes RSS; incremental heap: 9.14 MiB.
- CPU: 7324.465 ms user + 162.497 ms system; 111.581% utilization.

| Operation | First ms | Warm min ms | Warm max ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| singleCreate | 0.633 | 0.258 | 0.773 | 0.295 | 0.273 | 0.415 | 0.773 | 3,366 ops/s |
| uuidRead | 0.205 | 0.012 | 0.067 | 0.023 | 0.024 | 0.036 | 0.067 | 36,870 ops/s |
| equality | 0.430 | 0.174 | 1.628 | 0.279 | 0.258 | 0.337 | 1.628 | 3,316 ops/s |
| nestedEquality | 0.316 | 0.177 | 0.338 | 0.225 | 0.226 | 0.276 | 0.338 | 4,211 ops/s |
| numericRange | 0.309 | 0.137 | 1.034 | 0.228 | 0.222 | 0.295 | 1.034 | 4,115 ops/s |
| and | 0.914 | 0.541 | 2.291 | 0.832 | 0.721 | 1.161 | 2.291 | 1,176 ops/s |
| or | 0.411 | 0.370 | 0.883 | 0.411 | 0.387 | 0.455 | 0.883 | 2,360 ops/s |
| singleKeyUpdate | 1.904 | 0.138 | 0.252 | 0.160 | 0.142 | 0.224 | 0.252 | 6,162 ops/s |
| indexedKeyUpdate | 0.537 | 0.147 | 0.292 | 0.173 | 0.151 | 0.276 | 0.292 | 5,713 ops/s |
| numericIncrement | 0.556 | 0.152 | 0.296 | 0.220 | 0.229 | 0.277 | 0.296 | 4,486 ops/s |
| singleDelete | 0.488 | 0.104 | 0.231 | 0.149 | 0.135 | 0.213 | 0.231 | 6,603 ops/s |

| Sustained mode | In-flight | ops/s | p50 ms | p95 ms | p99 ms | CPU utilization |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 135,155 ops/s | 0.005 | 0.009 | 0.020 | 117.258% |
| write | 1 | 7,205 ops/s | 0.115 | 0.196 | 0.251 | 118.081% |
| mixed | 1 | 14,520 ops/s | 0.101 | 0.154 | 0.187 | 114.894% |
| read | 8 | 208,443 ops/s | 0.021 | 0.034 | 0.054 | 102.521% |
| write | 8 | 9,005 ops/s | 0.493 | 0.873 | 1.095 | 100.731% |
| mixed | 8 | 17,193 ops/s | 0.303 | 0.469 | 0.584 | 100.670% |

| Run | Status | Failure / skip reason |
| ---: | --- | --- |
| - | all passed | - |
## 10,000 objects

- Runs: 5/5 passed; fixture hash: `767927150f41a6967e99ab0e05f11128ba4f408f1b9bfc5e1fc753a84119ac8f`.
- Init: 1.159 ms; readiness: 1.025 ms; first object create: 6.040 ms.
- Bulk create/index: 3393.594 ms; 2,947 ops/s.
- Total independent run time: 9863.957 ms.
- Index entries/object: 17; indexing is synchronous and included in create time.
- Memory (idle / loaded / peak RSS): 62.50 MiB / 233.64 MiB / 255.70 MiB.
- Incremental memory/object: 17940.890 bytes RSS; incremental heap: 91.34 MiB.
- CPU: 10693.313 ms user + 266.696 ms system; 111.640% utilization.

| Operation | First ms | Warm min ms | Warm max ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| singleCreate | 0.771 | 0.346 | 0.435 | 0.380 | 0.366 | 0.420 | 0.435 | 2,616 ops/s |
| uuidRead | 0.198 | 0.012 | 0.056 | 0.018 | 0.017 | 0.031 | 0.056 | 48,170 ops/s |
| equality | 0.386 | 0.181 | 0.344 | 0.250 | 0.270 | 0.316 | 0.344 | 3,658 ops/s |
| nestedEquality | 0.557 | 0.228 | 0.472 | 0.311 | 0.295 | 0.413 | 0.472 | 3,060 ops/s |
| numericRange | 0.250 | 0.145 | 0.349 | 0.201 | 0.173 | 0.302 | 0.349 | 4,598 ops/s |
| and | 0.924 | 0.589 | 1.083 | 0.798 | 0.757 | 1.031 | 1.083 | 1,221 ops/s |
| or | 0.435 | 0.404 | 0.466 | 0.423 | 0.416 | 0.450 | 0.466 | 2,305 ops/s |
| singleKeyUpdate | 1.930 | 0.139 | 0.250 | 0.164 | 0.146 | 0.236 | 0.250 | 6,033 ops/s |
| indexedKeyUpdate | 0.553 | 0.159 | 0.329 | 0.186 | 0.164 | 0.285 | 0.329 | 5,296 ops/s |
| numericIncrement | 0.586 | 0.146 | 0.329 | 0.229 | 0.236 | 0.290 | 0.329 | 4,297 ops/s |
| singleDelete | 0.580 | 0.156 | 0.319 | 0.208 | 0.187 | 0.293 | 0.319 | 4,761 ops/s |

| Sustained mode | In-flight | ops/s | p50 ms | p95 ms | p99 ms | CPU utilization |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 120,164 ops/s | 0.006 | 0.011 | 0.022 | 118.293% |
| write | 1 | 6,730 ops/s | 0.126 | 0.203 | 0.247 | 117.227% |
| mixed | 1 | 13,164 ops/s | 0.112 | 0.166 | 0.199 | 112.446% |
| read | 8 | 187,148 ops/s | 0.023 | 0.038 | 0.059 | 102.777% |
| write | 8 | 8,070 ops/s | 0.557 | 0.965 | 1.127 | 100.983% |
| mixed | 8 | 15,175 ops/s | 0.344 | 0.528 | 0.598 | 101.299% |

| Run | Status | Failure / skip reason |
| ---: | --- | --- |
| - | all passed | - |
## 100,000 objects

- Runs: 5/5 passed; fixture hash: `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b`.
- Init: 1.135 ms; readiness: 1.001 ms; first object create: 5.904 ms.
- Bulk create/index: 45318.659 ms; 2,207 ops/s.
- Total independent run time: 52568.017 ms.
- Index entries/object: 17; indexing is synchronous and included in create time.
- Memory (idle / loaded / peak RSS): 62.48 MiB / 574.81 MiB / 595.77 MiB.
- Incremental memory/object: 5372.682 bytes RSS; incremental heap: 427.51 MiB.
- CPU: 54775.793 ms user + 803.966 ms system; 105.517% utilization.

| Operation | First ms | Warm min ms | Warm max ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| singleCreate | 1.225 | 0.545 | 0.823 | 0.613 | 0.597 | 0.725 | 0.823 | 1,624 ops/s |
| uuidRead | 0.190 | 0.011 | 0.077 | 0.023 | 0.020 | 0.055 | 0.077 | 39,397 ops/s |
| equality | 0.402 | 0.187 | 0.369 | 0.268 | 0.275 | 0.340 | 0.369 | 3,436 ops/s |
| nestedEquality | 0.562 | 0.237 | 0.579 | 0.316 | 0.290 | 0.408 | 0.579 | 2,980 ops/s |
| numericRange | 0.258 | 0.156 | 0.396 | 0.222 | 0.227 | 0.290 | 0.396 | 4,194 ops/s |
| and | 1.053 | 0.658 | 1.328 | 0.824 | 0.702 | 1.140 | 1.328 | 1,192 ops/s |
| or | 0.500 | 0.439 | 0.490 | 0.455 | 0.451 | 0.481 | 0.490 | 2,140 ops/s |
| singleKeyUpdate | 2.066 | 0.140 | 0.249 | 0.169 | 0.148 | 0.235 | 0.249 | 5,851 ops/s |
| indexedKeyUpdate | 0.663 | 0.174 | 0.343 | 0.218 | 0.192 | 0.317 | 0.343 | 4,527 ops/s |
| numericIncrement | 0.794 | 0.167 | 0.387 | 0.263 | 0.266 | 0.342 | 0.387 | 3,763 ops/s |
| singleDelete | 0.789 | 0.287 | 0.544 | 0.353 | 0.332 | 0.513 | 0.544 | 2,814 ops/s |

| Sustained mode | In-flight | ops/s | p50 ms | p95 ms | p99 ms | CPU utilization |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 116,062 ops/s | 0.006 | 0.011 | 0.020 | 118.757% |
| write | 1 | 6,280 ops/s | 0.140 | 0.211 | 0.266 | 114.835% |
| mixed | 1 | 12,260 ops/s | 0.121 | 0.179 | 0.214 | 113.489% |
| read | 8 | 173,610 ops/s | 0.025 | 0.041 | 0.061 | 102.820% |
| write | 8 | 7,602 ops/s | 0.589 | 1.027 | 1.130 | 100.893% |
| mixed | 8 | 14,374 ops/s | 0.360 | 0.556 | 0.627 | 101.527% |

| Run | Status | Failure / skip reason |
| ---: | --- | --- |
| - | all passed | - |
## 1,000,000 objects

- Runs: 0/5 passed; fixture hash: `none`.
- Init: n/a ms; readiness: n/a ms; first object create: n/a ms.
- Bulk create/index: n/a ms; n/a.
- Total independent run time: n/a ms.
- Index entries/object: n/a; indexing is synchronous and included in create time.
- Memory (idle / loaded / peak RSS): n/a / n/a / n/a.
- Incremental memory/object: n/a bytes RSS; incremental heap: n/a.
- CPU: 0.000 ms user + 0.000 ms system; n/a% utilization.

| Operation | First ms | Warm min ms | Warm max ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| singleCreate | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| uuidRead | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| equality | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| nestedEquality | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| numericRange | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| and | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| or | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| singleKeyUpdate | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| indexedKeyUpdate | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| numericIncrement | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| singleDelete | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |

| Sustained mode | In-flight | ops/s | p50 ms | p95 ms | p99 ms | CPU utilization |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| n/a | n/a | n/a | n/a | n/a | n/a | n/a |

| Run | Status | Failure / skip reason |
| ---: | --- | --- |
| 1 | failed | Node.js JavaScript heap out of memory |

## Historical v2 lifecycle comparison

The retained historical baseline and the current compatibility lane both use fixture v2 hash `25ebce8889cb93e29279301a3681ce66ebe80d5cb0d147387455ad5cddb44e48` / `25ebce8889cb93e29279301a3681ce66ebe80d5cb0d147387455ad5cddb44e48`. Historical: 22.16.0, 4 CPUs, 40 samples, 5 independent runs. Current compatibility: v24.18.0, 2 reported CPUs, 40 samples, 5 independent runs. The datasets and lifecycle query/update operations are equivalent, but runtime and hardware metadata differ, so this is a historical comparison rather than a controlled same-host comparison.

| v2 metric | Historical summary | Current compatibility median |
| --- | ---: | ---: |
| Create + index ms | 119.279 | 210.854 |
| UUID read p50 ms | 0.004 | 0.026 |
| Equality p50 ms | 0.206 | 0.292 |
| Nested equality p50 ms | 0.278 | 0.185 |
| Range p50 ms | 0.358 | 0.518 |
| Update p50 ms | 0.032 | 0.170 |
| Heap used | 11.51 MiB | 17.58 MiB |
| RSS | 45.29 MiB | 83.82 MiB |

## Raw results and failures

Raw independent runs and the manifest are stored under `/home/ubuntu/Dev/CoCreateJS/modules/db/test/benchmarks/runs/standard-2026-11-20T01-04-18.943Z`. Status counts: {"successfulRuns":15,"failedRuns":1,"notAttempted":4}. Provider summary appended to [cocreatedb.json](../providers/cocreatedb.json) without replacing historical data.

## Limits and follow-up

This phase measures the in-memory CoCreateDB prototype only. No MongoDB, Redis, Couchbase, CouchDB or CockroachDB adapters are included until each provider is run under this methodology. Results from historical MongoDB/Redis references are not ranked against these measurements. Distributed synchronization, replication, sharding, recovery, persistence durability, server/client separation, and transaction guarantees are out of scope.
