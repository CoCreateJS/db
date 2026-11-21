# CouchDB standardized benchmark results

- Run ID: `2026-11-20T13-16-20.359Z`; 2026-11-20T13:16:20.359Z to 2026-11-20T13:16:37.910Z.
- CouchDB 3.5.3; Node v24.18.0; source revision `3f3bb2f21f8fd2332b6f686bb50cfd8b1a553653`.
- Host: linux-x64, AMD EPYC 7571 (2 logical CPUs), 7838.21 MiB RAM.
- 1 independent fresh databases per size; 40 measured samples and 10 warmups; 1000 ms per sustained mode/concurrency.
- Process model: single CouchDB server plus Node fetch client over loopback HTTP. The server starts once, the trial databases are created/deleted per run, and the local server is stopped after the suite.
- A single seed document is used for first-create and index warmup measurements. Fixture records are bulk inserted in batches of 1,000, with Mango indexes defined before ingest. Index creation/setup, bulk-ingest index catch-up, and ingest time are reported separately.
- CouchDB document `_id` is reserved for the database document key, so it equals fixture `uuid`; the fixture application `_id` is stored as `appId`. Updates GET the current revision then PUT the full document; deletes likewise require the latest `_rev`. This measures CouchDB MVCC request costs.
- Timed Mango reads pin the intended JSON index with `use_index` and `allow_fallback:false`; correctness checks compare sorted UUIDs with the shared fixture expectations. Raw `_explain` plans are retained.
- Server CPU is approximate process tick accounting; server RSS sums CouchDB processes and may double-count shared pages. Disk size is CouchDB database reported size; filesystem-wide and index-directory sizes are in raw data only when separately available.

| Size | Passed | Fixture SHA-256 | Index setup ms | Catch-up ms | Bulk ingest + index maintenance ms | Records/s | CouchDB loaded RSS |
| ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 1/1 | `bc4f84465e1e80b84bf541e527e39516776dc4bc07afb233c45b825b29a846ac` | 415.964 | 176.062 | 146.685 | 6,817 ops/s | 148.30 MiB |

## 1,000 documents

- Independent runs: 1/1; fixture SHA-256: `bc4f84465e1e80b84bf541e527e39516776dc4bc07afb233c45b825b29a846ac`.
- Index setup: 415.964 ms; index catch-up after bulk ingest: 176.062 ms.
- First document create: 14.195 ms; bulk create plus concurrent index maintenance: 146.685 ms (6,817 ops/s).
- CouchDB RSS idle/loaded/peak: 148.30 MiB / 148.30 MiB / 149.05 MiB; client Node RSS idle/loaded/peak: 82.18 MiB / 82.18 MiB / 141.50 MiB.
- Final database disk size: n/a.

| Operation | First ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| singleCreate | 12.089 | 11.531 | 11.579 | 12.232 | 13.548 | 87 ops/s |
| uuidRead | 3.880 | 3.421 | 3.480 | 4.231 | 4.591 | 292 ops/s |
| equality | 8.644 | 9.894 | 9.598 | 10.879 | 23.819 | 101 ops/s |
| nestedEquality | 7.815 | 7.475 | 7.209 | 8.365 | 14.555 | 133 ops/s |
| numericRange | 23.010 | 22.848 | 21.881 | 27.573 | 38.382 | 44 ops/s |
| and | 9.801 | 10.551 | 9.719 | 15.081 | 18.294 | 95 ops/s |
| or | 68.612 | 43.443 | 42.485 | 47.151 | 67.279 | 23 ops/s |
| singleKeyUpdate | 40.148 | 14.819 | 14.749 | 16.066 | 18.963 | 67 ops/s |
| indexedKeyUpdate | 16.030 | 15.435 | 15.069 | 18.069 | 23.668 | 65 ops/s |
| numericIncrement | 15.651 | 15.260 | 14.865 | 16.975 | 24.486 | 66 ops/s |
| singleDelete | 15.055 | 14.723 | 14.602 | 15.924 | 16.699 | 68 ops/s |

| Sustained workload | Concurrency | ops/s | p50 ms | p95 ms | p99 ms | Client CPU | CouchDB CPU |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 322 ops/s | 3.061 | 3.472 | 4.752 | 28.358% | 103.821% |
| write | 1 | 69 ops/s | 14.084 | 16.648 | 21.972 | 14.155% | 91.011% |
| mixed | 1 | 111 ops/s | 12.436 | 15.245 | 22.461 | 16.901% | 87.730% |

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

## Raw outputs

Raw run JSON, manifest, summary, and this report are in `/home/ubuntu/Dev/CoCreateJS/modules/db/test/benchmarks/providers/couchdb/results/couchdb-standard-2026-11-20T13-16-20.359Z`. The append-only provider history is [couchdb.json](../summary.json).
The lane is standalone and loopback-only. It does not measure replication, clustered failover, remote network behavior, or multi-node consistency.
