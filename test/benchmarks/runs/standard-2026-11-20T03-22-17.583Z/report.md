# CoCreateDB standardized benchmark results

- Run ID: `2026-11-20T03-22-17.583Z`; executed: 2026-11-20T03:22:17.583Z to 2026-11-20T03:34:26.720Z.
- Source revision: `2955244dea8f32f0a7ebc16108239a82e721f58a`; DB version 1.0.0.
- Runtime: v24.18.0 / linux-x64; CPU: AMD EPYC 7571 (2 logical CPUs); RAM: 7838.21 MiB; limit: n/a.
- Method: 5 independent runs/size; 10 warmups and 40 samples per latency operation; 5000 ms sustained runs per workload/concurrency.
- Process model: single in-process Node process; benchmark client and database share CPU/RSS; durability: none; no disk or provider writes. Disk usage and I/O are not applicable.
- No competitor databases, containers, dependencies or datasets were installed or launched.

Each run is a fresh child process and database. Fixture data is generated in 1,000-record batches; object generation and fixture hashing are excluded from measured create/index time. The fixture hash is over the canonical pre-ingestion JSON dataset. Correctness checks compare UUID result sets before query timings are accepted. Measured request latency stops before result assertions. Sustained modes are read-only, increment-only writes, or alternating read/write calls; concurrency means outstanding in-process requests, not parallel database threads.

Initialization and readiness are reported separately. Index creation and maintenance are synchronous inside object creation, so create/index is one timed operation. The memory-only run has no disk I/O, persistence durability or network cost. CPU and RSS include both the benchmark client and database in the same Node process. Incremental memory/object is an approximate loaded-minus-idle RSS ratio.

| Size | Runs passed | Fixture hash | Create + index ms | Create ops/s | Loaded RSS | Peak RSS |
| ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 1,000 | 5/5 | `bc4f84465e1e80b84bf541e527e39516776dc4bc07afb233c45b825b29a846ac` | 316.528 | 3,159 ops/s | 85.73 MiB | 213.29 MiB |
| 10,000 | 5/5 | `767927150f41a6967e99ab0e05f11128ba4f408f1b9bfc5e1fc753a84119ac8f` | 3542.687 | 2,823 ops/s | 201.75 MiB | 288.36 MiB |
| 100,000 | 5/5 | `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b` | 47915.043 | 2,087 ops/s | 572.98 MiB | 648.06 MiB |

## 1,000 objects

- Runs: 5/5 passed; fixture hash: `bc4f84465e1e80b84bf541e527e39516776dc4bc07afb233c45b825b29a846ac`.
- Init: 1.118 ms; readiness: 1.010 ms; first object create: 6.100 ms.
- Bulk create/index: 316.528 ms; 3,159 ops/s.
- Total independent run time: 30860.138 ms.
- Index entries/object: 17; indexing is synchronous and included in create time.
- Memory (idle / loaded / peak RSS): 63.48 MiB / 85.73 MiB / 213.29 MiB.
- Incremental memory/object: 23281.664 bytes RSS; incremental heap: 8.93 MiB.
- CPU: 31516.411 ms user + 224.598 ms system; 102.787% utilization.

| Operation | First ms | Warm min ms | Warm max ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| singleCreate | 0.643 | 0.270 | 0.876 | 0.313 | 0.287 | 0.358 | 0.876 | 3,173 ops/s |
| uuidRead | 0.210 | 0.012 | 0.081 | 0.030 | 0.028 | 0.044 | 0.081 | 30,624 ops/s |
| equality | 0.604 | 0.352 | 0.598 | 0.494 | 0.500 | 0.557 | 0.598 | 1,923 ops/s |
| nestedEquality | 0.349 | 0.174 | 1.202 | 0.296 | 0.264 | 0.331 | 1.202 | 3,233 ops/s |
| numericRange | 0.527 | 0.320 | 0.569 | 0.406 | 0.366 | 0.538 | 0.569 | 2,358 ops/s |
| and | 1.683 | 1.331 | 2.678 | 1.621 | 1.424 | 2.043 | 2.678 | 609 ops/s |
| or | 1.105 | 1.048 | 1.523 | 1.100 | 1.065 | 1.243 | 1.523 | 899 ops/s |
| singleKeyUpdate | 2.047 | 0.139 | 0.263 | 0.166 | 0.147 | 0.252 | 0.263 | 5,962 ops/s |
| indexedKeyUpdate | 0.540 | 0.148 | 0.305 | 0.176 | 0.155 | 0.268 | 0.305 | 5,612 ops/s |
| numericIncrement | 0.588 | 0.152 | 0.320 | 0.228 | 0.234 | 0.284 | 0.320 | 4,335 ops/s |
| singleDelete | 0.468 | 0.105 | 0.250 | 0.150 | 0.144 | 0.208 | 0.250 | 6,582 ops/s |

| Sustained mode | In-flight | ops/s | p50 ms | p95 ms | p99 ms | CPU utilization |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 142,314 ops/s | 0.005 | 0.008 | 0.016 | 103.729% |
| write | 1 | 7,706 ops/s | 0.113 | 0.174 | 0.224 | 106.496% |
| mixed | 1 | 14,855 ops/s | 0.108 | 0.154 | 0.183 | 101.552% |
| read | 8 | 210,141 ops/s | 0.021 | 0.034 | 0.051 | 99.990% |
| write | 8 | 8,770 ops/s | 0.512 | 0.897 | 1.149 | 100.249% |
| mixed | 8 | 16,581 ops/s | 0.318 | 0.486 | 0.630 | 100.256% |

| Run | Status | Failure / skip reason |
| ---: | --- | --- |
| - | all passed | - |
## 10,000 objects

- Runs: 5/5 passed; fixture hash: `767927150f41a6967e99ab0e05f11128ba4f408f1b9bfc5e1fc753a84119ac8f`.
- Init: 1.085 ms; readiness: 1.004 ms; first object create: 6.018 ms.
- Bulk create/index: 3542.687 ms; 2,823 ops/s.
- Total independent run time: 34263.219 ms.
- Index entries/object: 17; indexing is synchronous and included in create time.
- Memory (idle / loaded / peak RSS): 63.46 MiB / 201.75 MiB / 288.36 MiB.
- Incremental memory/object: 14503.936 bytes RSS; incremental heap: 55.60 MiB.
- CPU: 35349.323 ms user + 345.662 ms system; 104.543% utilization.

| Operation | First ms | Warm min ms | Warm max ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| singleCreate | 0.805 | 0.359 | 0.600 | 0.402 | 0.387 | 0.454 | 0.600 | 2,473 ops/s |
| uuidRead | 0.196 | 0.012 | 0.051 | 0.018 | 0.017 | 0.031 | 0.051 | 48,495 ops/s |
| equality | 0.552 | 0.346 | 0.571 | 0.488 | 0.505 | 0.547 | 0.571 | 1,947 ops/s |
| nestedEquality | 0.593 | 0.316 | 0.733 | 0.393 | 0.351 | 0.505 | 0.733 | 2,446 ops/s |
| numericRange | 0.517 | 0.430 | 0.691 | 0.469 | 0.452 | 0.601 | 0.691 | 2,060 ops/s |
| and | 2.112 | 1.714 | 2.584 | 1.858 | 1.777 | 2.306 | 2.584 | 533 ops/s |
| or | 1.350 | 1.073 | 9.244 | 1.360 | 1.098 | 1.347 | 9.244 | 728 ops/s |
| singleKeyUpdate | 2.080 | 0.143 | 0.262 | 0.165 | 0.149 | 0.226 | 0.262 | 5,984 ops/s |
| indexedKeyUpdate | 0.574 | 0.164 | 0.372 | 0.195 | 0.172 | 0.286 | 0.372 | 5,065 ops/s |
| numericIncrement | 0.654 | 0.152 | 0.355 | 0.241 | 0.237 | 0.306 | 0.355 | 4,105 ops/s |
| singleDelete | 0.582 | 0.160 | 0.319 | 0.214 | 0.195 | 0.302 | 0.319 | 4,620 ops/s |

| Sustained mode | In-flight | ops/s | p50 ms | p95 ms | p99 ms | CPU utilization |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 135,409 ops/s | 0.006 | 0.009 | 0.016 | 104.070% |
| write | 1 | 7,051 ops/s | 0.124 | 0.186 | 0.236 | 107.277% |
| mixed | 1 | 13,242 ops/s | 0.119 | 0.171 | 0.209 | 105.616% |
| read | 8 | 191,360 ops/s | 0.023 | 0.037 | 0.056 | 100.029% |
| write | 8 | 7,933 ops/s | 0.566 | 0.974 | 1.179 | 101.051% |
| mixed | 8 | 14,723 ops/s | 0.353 | 0.540 | 0.690 | 101.177% |

| Run | Status | Failure / skip reason |
| ---: | --- | --- |
| - | all passed | - |
## 100,000 objects

- Runs: 5/5 passed; fixture hash: `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b`.
- Init: 1.097 ms; readiness: 0.981 ms; first object create: 6.037 ms.
- Bulk create/index: 47915.043 ms; 2,087 ops/s.
- Total independent run time: 79395.446 ms.
- Index entries/object: 17; indexing is synchronous and included in create time.
- Memory (idle / loaded / peak RSS): 63.54 MiB / 572.98 MiB / 648.06 MiB.
- Incremental memory/object: 5341.962 bytes RSS; incremental heap: 393.85 MiB.
- CPU: 81460.068 ms user + 934.316 ms system; 103.740% utilization.

| Operation | First ms | Warm min ms | Warm max ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| singleCreate | 1.225 | 0.572 | 0.719 | 0.616 | 0.606 | 0.669 | 0.719 | 1,616 ops/s |
| uuidRead | 0.259 | 0.012 | 0.064 | 0.022 | 0.018 | 0.051 | 0.064 | 40,486 ops/s |
| equality | 0.589 | 0.364 | 0.900 | 0.520 | 0.522 | 0.583 | 0.900 | 1,830 ops/s |
| nestedEquality | 0.585 | 0.328 | 0.793 | 0.426 | 0.385 | 0.532 | 0.793 | 2,258 ops/s |
| numericRange | 0.529 | 0.339 | 0.570 | 0.387 | 0.358 | 0.552 | 0.570 | 2,491 ops/s |
| and | 2.057 | 1.450 | 9.696 | 1.754 | 1.497 | 2.062 | 9.696 | 565 ops/s |
| or | 1.154 | 1.114 | 1.401 | 1.149 | 1.140 | 1.185 | 1.401 | 860 ops/s |
| singleKeyUpdate | 2.092 | 0.143 | 0.265 | 0.169 | 0.149 | 0.227 | 0.265 | 5,842 ops/s |
| indexedKeyUpdate | 0.652 | 0.177 | 0.367 | 0.223 | 0.191 | 0.321 | 0.367 | 4,427 ops/s |
| numericIncrement | 0.808 | 0.171 | 0.389 | 0.265 | 0.273 | 0.351 | 0.389 | 3,727 ops/s |
| singleDelete | 0.832 | 0.309 | 0.564 | 0.367 | 0.348 | 0.511 | 0.564 | 2,703 ops/s |

| Sustained mode | In-flight | ops/s | p50 ms | p95 ms | p99 ms | CPU utilization |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 123,766 ops/s | 0.006 | 0.010 | 0.016 | 104.117% |
| write | 1 | 6,595 ops/s | 0.138 | 0.199 | 0.243 | 107.356% |
| mixed | 1 | 12,643 ops/s | 0.126 | 0.174 | 0.208 | 102.218% |
| read | 8 | 170,495 ops/s | 0.026 | 0.043 | 0.063 | 99.995% |
| write | 8 | 7,335 ops/s | 0.610 | 1.057 | 1.302 | 101.221% |
| mixed | 8 | 13,796 ops/s | 0.375 | 0.577 | 0.734 | 101.175% |

| Run | Status | Failure / skip reason |
| ---: | --- | --- |
| - | all passed | - |

## Historical v2 lifecycle comparison

The retained historical baseline and the current compatibility lane both use fixture v2 hash `25ebce8889cb93e29279301a3681ce66ebe80d5cb0d147387455ad5cddb44e48` / `25ebce8889cb93e29279301a3681ce66ebe80d5cb0d147387455ad5cddb44e48`. Historical: 22.16.0, 4 CPUs, 40 samples, 5 independent runs. Current compatibility: v24.18.0, 2 reported CPUs, 40 samples, 5 independent runs. The datasets and lifecycle query/update operations are equivalent, but runtime and hardware metadata differ, so this is a historical comparison rather than a controlled same-host comparison.

| v2 metric | Historical summary | Current compatibility median |
| --- | ---: | ---: |
| Create + index ms | 119.279 | 216.767 |
| UUID read p50 ms | 0.004 | 0.023 |
| Equality p50 ms | 0.206 | 0.563 |
| Nested equality p50 ms | 0.278 | 0.237 |
| Range p50 ms | 0.358 | 0.909 |
| Update p50 ms | 0.032 | 0.147 |
| Heap used | 11.51 MiB | 18.59 MiB |
| RSS | 45.29 MiB | 86.22 MiB |

## Raw results and failures

Raw independent runs and the manifest are stored under `/home/ubuntu/Dev/CoCreateJS/modules/db/test/benchmarks/runs/standard-2026-11-20T03-22-17.583Z`. Status counts: {"successfulRuns":15,"failedRuns":0,"notAttempted":0}. Provider summary appended to [cocreatedb.json](../providers/cocreatedb.json) without replacing historical data.

## Limits and follow-up

This phase measures the in-memory CoCreateDB prototype only. No MongoDB, Redis, Couchbase, CouchDB or CockroachDB adapters are included until each provider is run under this methodology. Results from historical MongoDB/Redis references are not ranked against these measurements. Distributed synchronization, replication, sharding, recovery, persistence durability, server/client separation, and transaction guarantees are out of scope.
