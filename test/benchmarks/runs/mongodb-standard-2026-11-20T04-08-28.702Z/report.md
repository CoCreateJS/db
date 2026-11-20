# MongoDB benchmark results

- Run: `2026-11-20T04-08-28.702Z`; 2026-11-20T04:08:28.702Z to 2026-11-20T04:17:21.783Z.
- MongoDB: 9.0.8; Node driver: 7.9.0; source revision: `4dccde14ba2f645043954617648d7a75be326dfa`.
- Runtime: v24.18.0 on linux-x64; CPU AMD EPYC 7571 (2 logical CPUs); RAM 7838.21 MiB; detected process memory limit n/a.
- MongoDB binary predownload/setup took 462.119 ms, excluded from server startup and query measurements.
- Workload policy: 5 independent runs/size; 10 warmups and 40 samples per operation; 5000 ms per sustained mode/concurrency; concurrency 1, 8.
- The same programmatic lifecycle v3 fixture and canonical JSON hash used by CoCreateDB are used here. Input creation and fixture hashing are excluded from measured insert/index time.
- Queries and updates are checked against fixture-derived UUIDs/counts before timings are accepted. Read queries return at most 100 results and sort by UUID (numeric range sorts by rank).
- MongoDB uses explicit indexes over the fixture paths and compound keys needed to preserve the ordered query semantics; `_id_` is MongoDB’s built-in identity index. CoCreateDB automatically indexes artifact paths. The report records MongoDB’s complete index list and each winning query plan so query coverage can be audited.
- This is a standalone `mongod` child process with a 1 GiB WiredTiger cache and temporary local WiredTiger files, accessed by the Node driver over loopback TCP. Write acknowledgement is `w:1,j:false`, read preference `primary`, read concern `local`; there is no replica set or transaction workload. This differs from CoCreateDB’s in-process memory-only setup and must not be described as the same durability or transport guarantee.
- Client process and `mongod` CPU/RSS are recorded separately, including loaded-minus-idle RSS per fixture document. This first captured run includes client idle/loaded/final RSS but predates client peak-RSS instrumentation; client peak is therefore reported as unavailable. `mongod` peak is read from its process high-water RSS. Disk usage is reported; OS disk I/O counters were unavailable. Temporary files are deleted after each run. No production dependencies are changed.

| Size | Runs | Fixture hash | Index setup ms | Create/index ms | Documents stored | Data + indexes | mongod loaded RSS |
| ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 5/5 | `bc4f84465e1e80b84bf541e527e39516776dc4bc07afb233c45b825b29a846ac` | 161.424 | 99.524 | 1001.000 | 0.00 MiB + 0.06 MiB | 157.17 MiB |
| 10,000 | 5/5 | `767927150f41a6967e99ab0e05f11128ba4f408f1b9bfc5e1fc753a84119ac8f` | 160.540 | 732.649 | 10001.000 | 0.00 MiB + 0.06 MiB | 197.16 MiB |
| 100,000 | 5/5 | `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b` | 157.709 | 7091.419 | 100001.000 | 4.66 MiB + 10.63 MiB | 296.71 MiB |

## 1,000 documents

- Independent trials: 5/5; fixture SHA-256: `bc4f84465e1e80b84bf541e527e39516776dc4bc07afb233c45b825b29a846ac`.
- Mongo startup: 307.106 ms; driver connect/readiness: 37.793 ms; first insert: 2.845 ms.
- Explicit index setup on empty collection: 161.424 ms; insert/index-maintenance: 99.524 ms (10,048 ops/s).
- Total trial time: 31883.880 ms.
- Documents in DB (includes one seed document): 1001.000; data/index storage: 0.00 MiB / 0.06 MiB; temporary dbPath files: 200.14 MiB.
- Client idle/loaded/final/peak RSS: 89.43 MiB / 101.82 MiB / 271.03 MiB / n/a; mongod idle/loaded/peak RSS: 149.59 MiB / 157.17 MiB / 188.79 MiB.
- Incremental loaded RSS per fixture document: client 13008.896 B, mongod 7868.416 B. Client/server CPU: 23234.495 / 19790.000 ms (72.943% / 62.129%) per trial median. Disk I/O counters were unavailable.

| Operation | First ms | Warm min ms | Warm max ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| singleCreate | 1.338 | 0.570 | 0.987 | 0.628 | 0.601 | 0.721 | 0.987 | 1,586 ops/s |
| uuidRead | 1.755 | 0.672 | 1.663 | 0.878 | 0.846 | 1.082 | 1.663 | 1,124 ops/s |
| equality | 4.714 | 2.147 | 5.286 | 3.025 | 2.433 | 4.830 | 5.286 | 327 ops/s |
| nestedEquality | 1.662 | 1.342 | 2.540 | 1.618 | 1.491 | 1.970 | 2.540 | 612 ops/s |
| numericRange | 2.086 | 2.052 | 7.316 | 2.914 | 2.506 | 4.471 | 7.316 | 340 ops/s |
| and | 2.689 | 2.088 | 4.591 | 2.518 | 2.375 | 3.446 | 4.591 | 393 ops/s |
| or | 3.219 | 2.181 | 3.609 | 2.551 | 2.434 | 3.020 | 3.609 | 388 ops/s |
| singleKeyUpdate | 1.820 | 0.579 | 1.023 | 0.669 | 0.626 | 0.898 | 1.023 | 1,491 ops/s |
| indexedKeyUpdate | 0.841 | 0.607 | 0.890 | 0.673 | 0.652 | 0.768 | 0.890 | 1,478 ops/s |
| numericIncrement | 0.885 | 0.592 | 3.011 | 0.985 | 0.828 | 1.614 | 3.011 | 1,011 ops/s |
| singleDelete | 1.898 | 0.576 | 1.999 | 0.719 | 0.630 | 1.100 | 1.999 | 1,384 ops/s |

| Query | Winning indexes | Returned | Keys examined | Documents examined |
| --- | --- | ---: | ---: | ---: |
| equality | group_uuid | 100.000 | 100.000 | 100.000 |
| nestedEquality | profile_team_uuid | 50.000 | 50.000 | 50.000 |
| numericRange | rank | 100.000 | 100.000 | 100.000 |
| and | group_active_uuid | 100.000 | 100.000 | 100.000 |
| or | group_uuid | 100.000 | 101.000 | 100.000 |

| Sustained workload | In-flight | ops/s | p50 ms | p95 ms | p99 ms | Client CPU | mongod CPU |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 1,944 ops/s | 0.478 | 0.641 | 1.214 | 80.314% | 33.397% |
| write | 1 | 1,806 ops/s | 0.510 | 0.690 | 1.288 | 57.946% | 54.397% |
| mixed | 1 | 1,913 ops/s | 0.500 | 0.632 | 0.825 | 65.510% | 47.995% |
| read | 8 | 3,598 ops/s | 1.491 | 2.399 | 5.544 | 96.407% | 61.800% |
| write | 8 | 3,347 ops/s | 1.673 | 2.390 | 3.514 | 59.531% | 107.990% |
| mixed | 8 | 3,328 ops/s | 1.650 | 2.408 | 4.074 | 76.301% | 86.394% |

| Run | Status | Failure |
| ---: | --- | --- |
| - | all passed | - |
## 10,000 documents

- Independent trials: 5/5; fixture SHA-256: `767927150f41a6967e99ab0e05f11128ba4f408f1b9bfc5e1fc753a84119ac8f`.
- Mongo startup: 298.497 ms; driver connect/readiness: 38.349 ms; first insert: 2.829 ms.
- Explicit index setup on empty collection: 160.540 ms; insert/index-maintenance: 732.649 ms (13,649 ops/s).
- Total trial time: 32616.529 ms.
- Documents in DB (includes one seed document): 10001.000; data/index storage: 0.00 MiB / 0.06 MiB; temporary dbPath files: 200.19 MiB.
- Client idle/loaded/final/peak RSS: 89.38 MiB / 121.71 MiB / 276.34 MiB / n/a; mongod idle/loaded/peak RSS: 149.66 MiB / 197.16 MiB / 208.89 MiB.
- Incremental loaded RSS per fixture document: client 3355.853 B, mongod 4974.182 B. Client/server CPU: 23540.032 / 20760.000 ms (72.176% / 63.592%) per trial median. Disk I/O counters were unavailable.

| Operation | First ms | Warm min ms | Warm max ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| singleCreate | 1.704 | 0.578 | 0.963 | 0.669 | 0.637 | 0.824 | 0.963 | 1,489 ops/s |
| uuidRead | 1.674 | 0.668 | 1.565 | 0.906 | 0.856 | 1.249 | 1.565 | 1,092 ops/s |
| equality | 6.010 | 2.211 | 5.952 | 3.000 | 2.688 | 4.148 | 5.952 | 328 ops/s |
| nestedEquality | 2.884 | 2.069 | 5.457 | 2.747 | 2.466 | 3.925 | 5.457 | 360 ops/s |
| numericRange | 3.043 | 1.988 | 3.032 | 2.224 | 2.156 | 2.740 | 3.032 | 445 ops/s |
| and | 2.837 | 2.060 | 4.157 | 2.530 | 2.457 | 3.377 | 4.157 | 391 ops/s |
| or | 3.037 | 2.178 | 3.743 | 2.606 | 2.499 | 3.249 | 3.743 | 380 ops/s |
| singleKeyUpdate | 1.938 | 0.583 | 1.218 | 0.681 | 0.642 | 0.863 | 1.218 | 1,462 ops/s |
| indexedKeyUpdate | 0.860 | 0.622 | 1.688 | 0.785 | 0.698 | 1.298 | 1.688 | 1,269 ops/s |
| numericIncrement | 1.159 | 0.574 | 3.168 | 1.141 | 0.904 | 2.513 | 3.168 | 874 ops/s |
| singleDelete | 2.217 | 0.584 | 0.831 | 0.666 | 0.641 | 0.809 | 0.831 | 1,496 ops/s |

| Query | Winning indexes | Returned | Keys examined | Documents examined |
| --- | --- | ---: | ---: | ---: |
| equality | group_uuid | 100.000 | 100.000 | 100.000 |
| nestedEquality | profile_team_uuid | 100.000 | 100.000 | 100.000 |
| numericRange | rank | 100.000 | 100.000 | 100.000 |
| and | group_active_uuid | 100.000 | 100.000 | 100.000 |
| or | group_uuid | 100.000 | 101.000 | 100.000 |

| Sustained workload | In-flight | ops/s | p50 ms | p95 ms | p99 ms | Client CPU | mongod CPU |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 1,895 ops/s | 0.488 | 0.664 | 1.084 | 79.072% | 34.395% |
| write | 1 | 1,773 ops/s | 0.521 | 0.699 | 1.216 | 57.483% | 55.198% |
| mixed | 1 | 1,863 ops/s | 0.516 | 0.657 | 0.875 | 64.638% | 48.198% |
| read | 8 | 3,552 ops/s | 1.504 | 2.444 | 6.688 | 96.112% | 62.399% |
| write | 8 | 3,242 ops/s | 1.733 | 2.460 | 3.695 | 58.525% | 108.600% |
| mixed | 8 | 3,259 ops/s | 1.688 | 2.443 | 4.206 | 75.828% | 87.994% |

| Run | Status | Failure |
| ---: | --- | --- |
| - | all passed | - |
## 100,000 documents

- Independent trials: 5/5; fixture SHA-256: `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b`.
- Mongo startup: 307.948 ms; driver connect/readiness: 39.612 ms; first insert: 2.805 ms.
- Explicit index setup on empty collection: 157.709 ms; insert/index-maintenance: 7091.419 ms (14,102 ops/s).
- Total trial time: 39805.931 ms.
- Documents in DB (includes one seed document): 100001.000; data/index storage: 4.66 MiB / 10.63 MiB; temporary dbPath files: 215.64 MiB.
- Client idle/loaded/final/peak RSS: 89.55 MiB / 151.95 MiB / 260.79 MiB / n/a; mongod idle/loaded/peak RSS: 149.75 MiB / 296.71 MiB / 310.00 MiB.
- Incremental loaded RSS per fixture document: client 657.940 B, mongod 1544.028 B. Client/server CPU: 25372.773 / 27370.000 ms (63.794% / 68.595%) per trial median. Disk I/O counters were unavailable.

| Operation | First ms | Warm min ms | Warm max ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| singleCreate | 1.484 | 0.589 | 0.978 | 0.655 | 0.637 | 0.866 | 0.978 | 1,521 ops/s |
| uuidRead | 1.854 | 0.640 | 1.543 | 0.850 | 0.822 | 1.128 | 1.543 | 1,162 ops/s |
| equality | 3.601 | 2.125 | 7.732 | 3.074 | 2.450 | 5.611 | 7.732 | 320 ops/s |
| nestedEquality | 2.307 | 2.083 | 4.944 | 2.615 | 2.403 | 3.653 | 4.944 | 379 ops/s |
| numericRange | 3.059 | 1.965 | 3.673 | 2.264 | 2.154 | 2.744 | 3.673 | 437 ops/s |
| and | 2.649 | 2.055 | 2.969 | 2.246 | 2.195 | 2.691 | 2.969 | 441 ops/s |
| or | 2.897 | 2.132 | 3.580 | 2.472 | 2.356 | 3.218 | 3.580 | 401 ops/s |
| singleKeyUpdate | 1.800 | 0.562 | 2.828 | 0.968 | 0.751 | 2.310 | 2.828 | 1,029 ops/s |
| indexedKeyUpdate | 0.916 | 0.591 | 0.941 | 0.689 | 0.648 | 0.901 | 0.941 | 1,444 ops/s |
| numericIncrement | 0.890 | 0.562 | 2.603 | 0.870 | 0.730 | 1.843 | 2.603 | 1,145 ops/s |
| singleDelete | 1.625 | 0.628 | 1.736 | 0.755 | 0.673 | 0.831 | 1.736 | 1,320 ops/s |

| Query | Winning indexes | Returned | Keys examined | Documents examined |
| --- | --- | ---: | ---: | ---: |
| equality | group_uuid | 100.000 | 100.000 | 100.000 |
| nestedEquality | profile_team_uuid | 100.000 | 100.000 | 100.000 |
| numericRange | rank | 100.000 | 100.000 | 100.000 |
| and | group_active_uuid | 100.000 | 100.000 | 100.000 |
| or | group_uuid | 100.000 | 101.000 | 100.000 |

| Sustained workload | In-flight | ops/s | p50 ms | p95 ms | p99 ms | Client CPU | mongod CPU |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 1,910 ops/s | 0.492 | 0.637 | 1.103 | 79.935% | 34.597% |
| write | 1 | 1,818 ops/s | 0.516 | 0.646 | 0.856 | 57.640% | 56.200% |
| mixed | 1 | 1,884 ops/s | 0.510 | 0.654 | 0.822 | 61.912% | 49.197% |
| read | 8 | 3,580 ops/s | 1.483 | 2.361 | 5.210 | 95.300% | 62.796% |
| write | 8 | 3,187 ops/s | 1.733 | 2.598 | 3.957 | 58.225% | 107.792% |
| mixed | 8 | 3,317 ops/s | 1.673 | 2.388 | 3.829 | 75.262% | 89.196% |

| Run | Status | Failure |
| ---: | --- | --- |
| - | all passed | - |

## CoCreateDB comparison

Compared with latest standardized CoCreateDB provider summary `2026-11-20T03-22-17.583Z`. Fixture hashes are checked per size. These are same-fixture results, but not a direct like-for-like ranking: CoCreateDB is in-process and memory-only, while MongoDB uses loopback TCP and WiredTiger files with a 1 GiB cache. Different acknowledgment, persistence and transport costs are retained in the interpretation.

### 1,000 documents

Fixture hash matches: **true**; CoCreateDB source: `2026-11-20T03-22-17.583Z`.

| Metric | CoCreateDB p50 / total | MongoDB p50 / total |
| --- | ---: | ---: |
| UUID read p50 | 0.028 | 0.846 |
| Equality p50 | 0.500 | 2.433 |
| Nested equality p50 | 0.264 | 1.491 |
| Range p50 | 0.366 | 2.506 |
| AND p50 | 1.424 | 2.375 |
| OR p50 | 1.065 | 2.434 |
| Create plus index setup ms | 316.528 | 260.948 |
| Single update p50 | 0.147 | 0.626 |
| Increment p50 | 0.234 | 0.828 |
| Delete p50 | 0.144 | 0.630 |

### 10,000 documents

Fixture hash matches: **true**; CoCreateDB source: `2026-11-20T03-22-17.583Z`.

| Metric | CoCreateDB p50 / total | MongoDB p50 / total |
| --- | ---: | ---: |
| UUID read p50 | 0.017 | 0.856 |
| Equality p50 | 0.505 | 2.688 |
| Nested equality p50 | 0.351 | 2.466 |
| Range p50 | 0.452 | 2.156 |
| AND p50 | 1.777 | 2.457 |
| OR p50 | 1.098 | 2.499 |
| Create plus index setup ms | 3542.687 | 893.188 |
| Single update p50 | 0.149 | 0.642 |
| Increment p50 | 0.237 | 0.904 |
| Delete p50 | 0.195 | 0.641 |

### 100,000 documents

Fixture hash matches: **true**; CoCreateDB source: `2026-11-20T03-22-17.583Z`.

| Metric | CoCreateDB p50 / total | MongoDB p50 / total |
| --- | ---: | ---: |
| UUID read p50 | 0.018 | 0.822 |
| Equality p50 | 0.522 | 2.450 |
| Nested equality p50 | 0.385 | 2.403 |
| Range p50 | 0.358 | 2.154 |
| AND p50 | 1.497 | 2.195 |
| OR p50 | 1.140 | 2.356 |
| Create plus index setup ms | 47915.043 | 7249.127 |
| Single update p50 | 0.149 | 0.751 |
| Increment p50 | 0.273 | 0.730 |
| Delete p50 | 0.348 | 0.673 |

## Historical MongoDB project numbers

The existing historical summary is from 2026-11-14, 1000 records, 3 samples reported as a mean, and lacks raw provider outputs and a fixture hash. Keep it distinct from the new p50 measurements; it is not a controlled comparison.

| Historical metric | Historical mean ms | New 1K warm p50 ms |
| --- | ---: | ---: |
| UUID read | 1.747 | 0.846 |
| Equality read | 1.758 | 2.433 |
| Numeric range read | 3.457 | 2.506 |
| Create | 1.737 | 0.601 |
| UUID update | 2.206 | 0.626 |

## Raw results and failures

Raw runs and manifest: `/home/ubuntu/Dev/CoCreateJS/modules/db/test/benchmarks/runs/mongodb-standard-2026-11-20T04-08-28.702Z`. Counts: `{"successfulRuns":15,"failedRuns":0,"notAttempted":0}`. Provider summary appended to [mongodb.json](../../providers/mongodb.json), retaining historical values.

## Reproduce

```sh
npm ci --prefix test/benchmarks/providers/mongodb
npm run benchmark --prefix test/benchmarks/providers/mongodb
```

The runner defaults to 1,000, 10,000 and 100,000 documents. Override sizes or run policy with positional sizes, `BENCH_RUNS`, `BENCH_SAMPLES`, `BENCH_WARMUPS`, `BENCH_SUSTAIN_MS`, `BENCH_CONCURRENCY` and `BENCH_OUTPUT_DIR`. MongoDB server 9.0.8 is pinned in the adapter; MongoDB binary downloads are cached outside the repository. This adapter is for the initial single-node baseline only; replication and durability comparisons are future work.
