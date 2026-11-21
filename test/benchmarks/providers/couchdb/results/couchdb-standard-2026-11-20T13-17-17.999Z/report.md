# CouchDB standardized benchmark results

- Run ID: `2026-11-20T13-17-17.999Z`; 2026-11-20T13:17:17.999Z to 2026-11-20T13:35:37.014Z.
- CouchDB 3.5.3; Node v24.18.0; source revision `3f3bb2f21f8fd2332b6f686bb50cfd8b1a553653`.
- Host: linux-x64, AMD EPYC 7571 (2 logical CPUs), 7838.21 MiB RAM.
- 5 independent fresh databases per size; 40 measured samples and 10 warmups; 5000 ms per sustained mode/concurrency.
- Process model: single CouchDB server plus Node fetch client over loopback HTTP. The server starts once, the trial databases are created/deleted per run, and the local server is stopped after the suite.
- A single seed document is used for first-create and index warmup measurements. Fixture records are bulk inserted in batches of 1,000, with Mango indexes defined before ingest. Index creation/setup, bulk-ingest index catch-up, and ingest time are reported separately.
- CouchDB document `_id` is reserved for the database document key, so it equals fixture `uuid`; the fixture application `_id` is stored as `appId`. Updates GET the current revision then PUT the full document; deletes likewise require the latest `_rev`. This measures CouchDB MVCC request costs.
- Indexed Mango reads pin the intended JSON index with `use_index` and `allow_fallback:false`; correctness checks compare UUID results with the shared fixture expectations. CouchDB rejects the forced compound index for the `$or` query, so that case uses the normal planner and its `_explain` plan shows `_all_docs` (a full scan). Raw plans are retained.
- Server CPU is approximate process tick accounting; server RSS sums CouchDB processes and may double-count shared pages. Disk size is CouchDB database reported size; filesystem-wide and index-directory sizes are in raw data only when separately available.

| Size | Passed | Fixture SHA-256 | Index setup ms | Catch-up ms | Bulk ingest + index maintenance ms | Records/s | CouchDB loaded RSS |
| ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 5/5 | `bc4f84465e1e80b84bf541e527e39516776dc4bc07afb233c45b825b29a846ac` | 304.924 | 166.069 | 155.511 | 6,430 ops/s | 174.96 MiB |
| 10,000 | 5/5 | `767927150f41a6967e99ab0e05f11128ba4f408f1b9bfc5e1fc753a84119ac8f` | 298.984 | 1681.656 | 1386.015 | 7,215 ops/s | 190.19 MiB |
| 100,000 | 5/5 | `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b` | 298.105 | 20912.852 | 13711.895 | 7,293 ops/s | 221.29 MiB |

## 1,000 documents

- Independent runs: 5/5; fixture SHA-256: `bc4f84465e1e80b84bf541e527e39516776dc4bc07afb233c45b825b29a846ac`.
- Index setup: 304.924 ms; index catch-up after bulk ingest: 166.069 ms.
- First document create: 13.943 ms; bulk create plus concurrent index maintenance: 155.511 ms (6,430 ops/s).
- CouchDB RSS idle/loaded/peak: 156.33 MiB / 174.96 MiB / 179.33 MiB; client Node RSS idle/loaded/peak: 53.59 MiB / 82.44 MiB / 241.57 MiB.
- Final database disk size: n/a.

| Operation | First ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| singleCreate | 11.513 | 11.402 | 11.270 | 12.350 | 16.569 | 88 ops/s |
| uuidRead | 3.917 | 3.935 | 3.813 | 4.796 | 5.892 | 254 ops/s |
| equality | 9.630 | 9.753 | 9.691 | 11.323 | 12.424 | 102 ops/s |
| nestedEquality | 7.674 | 7.471 | 7.346 | 8.906 | 9.937 | 133 ops/s |
| numericRange | 23.335 | 23.070 | 22.752 | 26.154 | 28.366 | 43 ops/s |
| and | 11.103 | 10.011 | 9.814 | 11.968 | 14.633 | 100 ops/s |
| or | 43.465 | 44.696 | 43.610 | 54.968 | 61.723 | 22 ops/s |
| singleKeyUpdate | 15.729 | 15.019 | 14.900 | 16.134 | 18.227 | 67 ops/s |
| indexedKeyUpdate | 15.319 | 15.174 | 14.609 | 20.011 | 22.266 | 66 ops/s |
| numericIncrement | 15.211 | 14.840 | 14.566 | 15.960 | 22.060 | 67 ops/s |
| singleDelete | 15.592 | 14.548 | 14.444 | 15.636 | 16.238 | 69 ops/s |

| Sustained workload | Concurrency | ops/s | p50 ms | p95 ms | p99 ms | Client CPU | CouchDB CPU |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 322 ops/s | 3.080 | 3.588 | 4.728 | 26.450% | 100.988% |
| write | 1 | 67 ops/s | 14.458 | 17.486 | 20.210 | 13.571% | 96.994% |
| mixed | 1 | 112 ops/s | 10.734 | 15.213 | 16.921 | 16.224% | 85.643% |
| read | 8 | 695 ops/s | 9.101 | 12.314 | 15.567 | 40.630% | 155.350% |
| write | 8 | 181 ops/s | 40.495 | 49.396 | 66.173 | 26.844% | 128.764% |
| mixed | 8 | 217 ops/s | 22.589 | 37.462 | 52.784 | 28.378% | 122.277% |

| Run | Status | Failure / skip reason |
| ---: | --- | --- |
| - | all passed | - |
## 10,000 documents

- Independent runs: 5/5; fixture SHA-256: `767927150f41a6967e99ab0e05f11128ba4f408f1b9bfc5e1fc753a84119ac8f`.
- Index setup: 298.984 ms; index catch-up after bulk ingest: 1681.656 ms.
- First document create: 13.466 ms; bulk create plus concurrent index maintenance: 1386.015 ms (7,215 ops/s).
- CouchDB RSS idle/loaded/peak: 179.80 MiB / 190.19 MiB / 207.32 MiB; client Node RSS idle/loaded/peak: 53.60 MiB / 103.34 MiB / 246.74 MiB.
- Final database disk size: n/a.

| Operation | First ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| singleCreate | 12.120 | 11.443 | 11.381 | 12.117 | 14.333 | 87 ops/s |
| uuidRead | 3.931 | 3.520 | 3.578 | 4.010 | 4.520 | 283 ops/s |
| equality | 9.913 | 9.982 | 9.857 | 11.775 | 13.661 | 100 ops/s |
| nestedEquality | 9.245 | 10.167 | 10.005 | 11.678 | 12.485 | 98 ops/s |
| numericRange | 22.365 | 23.360 | 23.350 | 24.856 | 28.883 | 43 ops/s |
| and | 9.961 | 10.683 | 10.315 | 12.774 | 25.822 | 93 ops/s |
| or | 44.656 | 43.619 | 42.891 | 46.574 | 49.933 | 23 ops/s |
| singleKeyUpdate | 15.755 | 14.938 | 14.883 | 16.266 | 17.209 | 67 ops/s |
| indexedKeyUpdate | 15.267 | 15.304 | 14.743 | 16.773 | 22.085 | 65 ops/s |
| numericIncrement | 15.541 | 14.660 | 14.587 | 15.706 | 16.155 | 68 ops/s |
| singleDelete | 15.337 | 14.859 | 14.915 | 16.127 | 17.302 | 67 ops/s |

| Sustained workload | Concurrency | ops/s | p50 ms | p95 ms | p99 ms | Client CPU | CouchDB CPU |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 317 ops/s | 3.118 | 3.697 | 4.597 | 26.198% | 101.179% |
| write | 1 | 67 ops/s | 14.891 | 16.382 | 19.498 | 12.994% | 87.180% |
| mixed | 1 | 109 ops/s | 6.953 | 16.188 | 17.930 | 15.923% | 97.596% |
| read | 8 | 645 ops/s | 9.707 | 13.196 | 17.430 | 39.461% | 159.297% |
| write | 8 | 150 ops/s | 48.079 | 57.027 | 73.281 | 24.470% | 157.933% |
| mixed | 8 | 185 ops/s | 25.135 | 45.093 | 62.632 | 22.572% | 159.329% |

| Run | Status | Failure / skip reason |
| ---: | --- | --- |
| - | all passed | - |
## 100,000 documents

- Independent runs: 5/5; fixture SHA-256: `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b`.
- Index setup: 298.105 ms; index catch-up after bulk ingest: 20912.852 ms.
- First document create: 13.887 ms; bulk create plus concurrent index maintenance: 13711.895 ms (7,293 ops/s).
- CouchDB RSS idle/loaded/peak: 180.69 MiB / 221.29 MiB / 260.23 MiB; client Node RSS idle/loaded/peak: 53.48 MiB / 128.27 MiB / 297.00 MiB.
- Final database disk size: n/a.

| Operation | First ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| singleCreate | 13.929 | 13.364 | 12.023 | 18.827 | 21.634 | 75 ops/s |
| uuidRead | 4.507 | 3.745 | 3.681 | 4.337 | 5.315 | 267 ops/s |
| equality | 11.268 | 10.168 | 9.955 | 11.778 | 13.655 | 98 ops/s |
| nestedEquality | 9.981 | 9.767 | 9.661 | 11.574 | 12.307 | 102 ops/s |
| numericRange | 25.712 | 26.558 | 25.942 | 28.760 | 29.808 | 38 ops/s |
| and | 11.537 | 10.802 | 10.563 | 11.775 | 13.315 | 92 ops/s |
| or | 45.003 | 43.429 | 42.969 | 47.870 | 50.794 | 23 ops/s |
| singleKeyUpdate | 16.950 | 17.331 | 16.763 | 23.210 | 29.697 | 58 ops/s |
| indexedKeyUpdate | 16.422 | 16.971 | 16.289 | 20.034 | 35.433 | 59 ops/s |
| numericIncrement | 15.947 | 16.656 | 15.664 | 17.735 | 45.944 | 60 ops/s |
| singleDelete | 16.117 | 16.412 | 15.902 | 19.610 | 21.505 | 61 ops/s |

| Sustained workload | Concurrency | ops/s | p50 ms | p95 ms | p99 ms | Client CPU | CouchDB CPU |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 293 ops/s | 3.277 | 4.169 | 6.535 | 28.356% | 103.594% |
| write | 1 | 63 ops/s | 15.594 | 17.976 | 23.823 | 13.095% | 91.380% |
| mixed | 1 | 105 ops/s | 11.187 | 16.325 | 18.794 | 16.318% | 93.266% |
| read | 8 | 638 ops/s | 10.085 | 13.348 | 18.883 | 38.167% | 157.895% |
| write | 8 | 159 ops/s | 45.040 | 56.082 | 71.958 | 25.004% | 135.078% |
| mixed | 8 | 196 ops/s | 24.407 | 41.653 | 51.971 | 22.422% | 127.214% |

| Run | Status | Failure / skip reason |
| ---: | --- | --- |
| - | all passed | - |

## Same-fixture reference runs

These are the latest stored provider runs, not simultaneous trials. Matching fixture hashes are shown; configurations, index timing boundaries, durability, and run times differ, so treat this as context rather than a controlled ranking.

| Size | Provider | Create + index ms | UUID p50 ms | Equality p50 ms | Range p50 ms | Fixture match |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1,000 | CoCreateDB | 317.416 | 0.029 | 0.270 | 0.248 | yes |
| 1,000 | MongoDB | 99.524 | 0.846 | 2.433 | 2.506 | yes |
| 1,000 | Redis JSON/Search | 133.660 | 0.240 | 2.263 | 1.992 | yes |
| 1,000 | Couchbase | 509.661 | 0.427 | 18.641 | 18.047 | yes |
| 10,000 | CoCreateDB | 3572.970 | 0.027 | 0.281 | 0.181 | yes |
| 10,000 | MongoDB | 732.649 | 0.856 | 2.688 | 2.156 | yes |
| 10,000 | Redis JSON/Search | 1274.288 | 0.236 | 2.320 | 2.206 | yes |
| 10,000 | Couchbase | 4437.136 | 0.432 | 18.608 | 18.039 | yes |
| 100,000 | CoCreateDB | 47243.970 | 0.019 | 0.286 | 0.207 | yes |
| 100,000 | MongoDB | 7091.419 | 0.822 | 2.450 | 2.154 | yes |
| 100,000 | Redis JSON/Search | 12844.029 | 0.206 | 6.123 | 7.793 | yes |
| 100,000 | Couchbase | 40726.827 | 0.425 | 18.200 | 18.257 | yes |

## Raw outputs

Raw run JSON, manifest, summary, and this report are in `/home/ubuntu/Dev/CoCreateJS/modules/db/test/benchmarks/providers/couchdb/results/couchdb-standard-2026-11-20T13-17-17.999Z`. The append-only provider history is [couchdb.json](../summary.json).
The lane is standalone and loopback-only. It does not measure replication, clustered failover, remote network behavior, or multi-node consistency. The `$or` result timing includes the provider’s full-scan plan and is not an indexed-query comparison.
