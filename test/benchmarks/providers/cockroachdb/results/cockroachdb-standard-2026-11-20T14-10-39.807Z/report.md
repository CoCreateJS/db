# CockroachDB standardized benchmark results

- Run ID: `2026-11-20T14-10-39.807Z`; 2026-11-20T14:10:39.807Z to 2026-11-20T14:10:55.987Z.
- CockroachDB CockroachDB CCL v26.3.5 (x86_64-pc-linux-gnu, built 2026/11/03 21:06:15, go1.26.10); pg 8.23.1; source revision `3f3bb2f21f8fd2332b6f686bb50cfd8b1a553653`.
- Host: linux-x64, AMD EPYC 7571 (2 logical CPUs), 7838.21 MiB RAM.
- 1 independent fresh databases per size; 40 samples and 10 warmups per operation; 1000 ms per sustained mode/concurrency.
- CockroachDB starts once as a single local node, stores its Pebble data in the user cache, and stops after the suite. Each trial creates and drops a separate SQL database. The single-node result does not measure distributed replication or multi-node consensus.
- Documents are stored as JSONB with typed columns for the indexed fields. Five secondary indexes are created on an empty table before ingest; their maintenance happens synchronously as rows are inserted. Index setup and ingest are timed separately.
- Indexed reads use CockroachDB `FORCE_INDEX` hints and retain `EXPLAIN` output. Queries return the full JSONB document; the fixture hash is computed before SQL column projection.
- Updates use SQL JSONB merge plus the indexed typed-column update when needed. UUID update/delete operations use the primary key directly. CockroachDB uses the default SERIALIZABLE transaction isolation; retries are not added by the benchmark client.
- Node store bytes are whole-store measurements, including CockroachDB system tables and data from trial databases; they are not isolated per-database sizes. Server RSS is the process resident set; CPU tick accounting is approximate.

| Size | Passed | Fixture SHA-256 | Index setup ms | Bulk ingest + index work ms | Rows/s | Loaded server RSS |
| ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 1,000 | 1/1 | `bc4f84465e1e80b84bf541e527e39516776dc4bc07afb233c45b825b29a846ac` | 5525.379 | 196.685 | 5,084 ops/s | 515.25 MiB |

## 1,000 documents

- Trials: 1/1 passed; fixture SHA-256: `bc4f84465e1e80b84bf541e527e39516776dc4bc07afb233c45b825b29a846ac`.
- Table setup: 100.768 ms; secondary index setup on empty table: 5525.379 ms.
- First row create: 25.298 ms; bulk insert with indexes maintained: 196.685 ms (5,084 ops/s).
- CockroachDB RSS idle/loaded/peak: 464.47 MiB / 515.25 MiB / 515.25 MiB; client Node RSS idle/loaded/peak: 62.50 MiB / 69.89 MiB / 77.80 MiB.
- Pebble node-store bytes (whole single-node store, not per database): 632.63 MiB.

| Operation | First ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| singleCreate | 5.446 | 5.034 | 4.905 | 5.708 | 7.536 | 198 ops/s |
| uuidRead | 2.060 | 1.446 | 1.230 | 2.639 | 5.331 | 688 ops/s |
| equality | 6.258 | 5.546 | 5.498 | 6.051 | 6.712 | 179 ops/s |
| nestedEquality | 3.674 | 4.062 | 3.881 | 5.555 | 5.975 | 245 ops/s |
| numericRange | 5.261 | 4.651 | 4.458 | 5.718 | 7.614 | 214 ops/s |
| and | 4.092 | 4.771 | 4.628 | 5.341 | 5.766 | 208 ops/s |
| or | 5.084 | 4.860 | 4.756 | 5.067 | 8.372 | 205 ops/s |
| singleKeyUpdate | 7.031 | 5.402 | 5.332 | 5.623 | 8.166 | 185 ops/s |
| indexedKeyUpdate | 6.517 | 5.704 | 5.394 | 7.108 | 9.242 | 175 ops/s |
| numericIncrement | 6.520 | 5.500 | 5.270 | 6.690 | 7.128 | 181 ops/s |
| singleDelete | 13.411 | 5.542 | 5.349 | 7.104 | 8.070 | 180 ops/s |

| Sustained mode | Concurrency | ops/s | p50 ms | p95 ms | p99 ms | Client CPU | CockroachDB CPU |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 942 ops/s | 0.951 | 1.318 | 2.387 | 27.071% | 101.910% |
| write | 1 | 176 ops/s | 5.493 | 6.974 | 8.866 | 10.671% | 50.741% |
| mixed | 1 | 317 ops/s | 1.945 | 5.441 | 5.948 | 10.734% | 53.978% |

| Trial | Status | Failure / skip reason |
| ---: | --- | --- |
| - | all passed | - |

## Same-fixture reference runs

These references are the latest stored runs, not simultaneous controlled trials. Matching fixture hashes confirm equivalent input documents; provider schemas, persistence behavior, durability, and measurement boundaries still differ.

| Size | Provider | Create/index ms | UUID p50 ms | Equality p50 ms | Range p50 ms | Fixture match |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1,000 | CoCreateDB | 317.416 | 0.029 | 0.270 | 0.248 | yes |
| 1,000 | MongoDB | 99.524 | 0.846 | 2.433 | 2.506 | yes |
| 1,000 | Redis JSON/Search | 133.660 | 0.240 | 2.263 | 1.992 | yes |
| 1,000 | Couchbase | 509.661 | 0.427 | 18.641 | 18.047 | yes |
| 1,000 | CouchDB | 155.511 | 3.813 | 9.691 | 22.752 | yes |

## Raw outputs

Raw trial JSON, manifest, summary, and this report are stored in `/home/ubuntu/Dev/CoCreateJS/modules/db/test/benchmarks/providers/cockroachdb/results/cockroachdb-standard-2026-11-20T14-10-39.807Z`. Provider history appends to [cockroachdb.json](../summary.json).
