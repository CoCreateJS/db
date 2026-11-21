# CockroachDB standardized benchmark results

- Run ID: `2026-11-20T14-11-38.139Z`; 2026-11-20T14:11:38.139Z to 2026-11-20T14:23:06.640Z.
- Server build: CockroachDB CCL v26.3.5 (x86_64-pc-linux-gnu, built 2026/11/03 21:06:15, go1.26.10); pg 8.23.1; source revision `3f3bb2f21f8fd2332b6f686bb50cfd8b1a553653`.
- Host: linux-x64, AMD EPYC 7571 (2 logical CPUs), 7838.21 MiB RAM.
- 5 independent fresh databases per size; 40 samples and 10 warmups per operation; 5000 ms per sustained mode/concurrency.
- CockroachDB starts once as a single local node with a fresh benchmark store, stores its Pebble data in the user cache, and stops after the suite. Each trial creates and drops a separate SQL database. The single-node result does not measure distributed replication or multi-node consensus.
- Documents are stored as JSONB with typed columns for the indexed fields. Five secondary indexes are created on an empty table before ingest; their maintenance happens synchronously as rows are inserted. Index setup and ingest are timed separately.
- Indexed reads use CockroachDB `FORCE_INDEX` hints and retain `EXPLAIN` output. Queries return the full JSONB document; the fixture hash is computed before SQL column projection.
- Updates use SQL JSONB merge plus the indexed typed-column update when needed. UUID update/delete operations use the primary key directly. CockroachDB uses the default SERIALIZABLE transaction isolation; retries are not added by the benchmark client.
- Node store bytes are whole-store measurements, including CockroachDB system tables and data from trial databases; they are not isolated per-database sizes. Server RSS is the process resident set; CPU tick accounting is approximate.

| Size | Passed | Fixture SHA-256 | Index setup ms | Bulk ingest + index work ms | Rows/s | Loaded server RSS |
| ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 1,000 | 5/5 | `bc4f84465e1e80b84bf541e527e39516776dc4bc07afb233c45b825b29a846ac` | 4517.423 | 172.199 | 5,807 ops/s | 818.38 MiB |
| 10,000 | 5/5 | `767927150f41a6967e99ab0e05f11128ba4f408f1b9bfc5e1fc753a84119ac8f` | 4212.211 | 1731.548 | 5,775 ops/s | 1118.78 MiB |
| 100,000 | 5/5 | `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b` | 6048.762 | 17519.972 | 5,708 ops/s | 1498.30 MiB |

## 1,000 documents

- Trials: 5/5 passed; fixture SHA-256: `bc4f84465e1e80b84bf541e527e39516776dc4bc07afb233c45b825b29a846ac`.
- Table setup: 99.044 ms; secondary index setup on empty table: 4517.423 ms.
- First row create: 23.586 ms; bulk insert with indexes maintained: 172.199 ms (5,807 ops/s).
- CockroachDB RSS idle/loaded/peak: 809.93 MiB / 818.38 MiB / 818.38 MiB; client Node RSS idle/loaded/peak: 62.48 MiB / 69.27 MiB / 81.77 MiB.
- Pebble node-store bytes (whole single-node store, not per database): 670.23 MiB.

| Operation | First ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| singleCreate | 5.689 | 4.857 | 4.851 | 5.278 | 5.566 | 206 ops/s |
| uuidRead | 1.385 | 1.073 | 0.978 | 1.346 | 1.804 | 928 ops/s |
| equality | 5.239 | 5.001 | 4.637 | 5.973 | 7.097 | 198 ops/s |
| nestedEquality | 3.647 | 3.480 | 3.361 | 4.334 | 4.914 | 286 ops/s |
| numericRange | 4.323 | 4.917 | 4.747 | 6.027 | 7.910 | 202 ops/s |
| and | 4.773 | 5.099 | 4.716 | 6.094 | 10.550 | 195 ops/s |
| or | 5.004 | 4.936 | 4.890 | 5.356 | 5.585 | 202 ops/s |
| singleKeyUpdate | 6.347 | 5.267 | 5.151 | 5.629 | 6.956 | 190 ops/s |
| indexedKeyUpdate | 6.162 | 5.515 | 5.433 | 6.503 | 7.115 | 181 ops/s |
| numericIncrement | 6.330 | 5.582 | 5.315 | 6.869 | 7.807 | 179 ops/s |
| singleDelete | 7.966 | 4.949 | 4.941 | 5.173 | 6.382 | 202 ops/s |

| Sustained mode | Concurrency | ops/s | p50 ms | p95 ms | p99 ms | Client CPU | CockroachDB CPU |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 1,102 ops/s | 0.835 | 1.201 | 1.933 | 28.068% | 98.196% |
| write | 1 | 189 ops/s | 5.201 | 5.862 | 7.287 | 5.780% | 49.386% |
| mixed | 1 | 319 ops/s | 4.588 | 5.464 | 6.599 | 8.532% | 54.166% |
| read | 8 | 2,149 ops/s | 2.699 | 4.347 | 6.511 | 36.586% | 144.154% |
| write | 8 | 594 ops/s | 10.901 | 15.248 | 22.252 | 7.456% | 116.281% |
| mixed | 8 | 702 ops/s | 7.015 | 11.864 | 14.709 | 11.517% | 98.984% |

| Trial | Status | Failure / skip reason |
| ---: | --- | --- |
| - | all passed | - |
## 10,000 documents

- Trials: 5/5 passed; fixture SHA-256: `767927150f41a6967e99ab0e05f11128ba4f408f1b9bfc5e1fc753a84119ac8f`.
- Table setup: 99.337 ms; secondary index setup on empty table: 4212.211 ms.
- First row create: 23.380 ms; bulk insert with indexes maintained: 1731.548 ms (5,775 ops/s).
- CockroachDB RSS idle/loaded/peak: 1054.12 MiB / 1118.78 MiB / 1120.46 MiB; client Node RSS idle/loaded/peak: 62.16 MiB / 88.45 MiB / 95.03 MiB.
- Pebble node-store bytes (whole single-node store, not per database): 809.41 MiB.

| Operation | First ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| singleCreate | 5.314 | 4.987 | 4.803 | 5.360 | 5.630 | 200 ops/s |
| uuidRead | 1.377 | 0.919 | 0.888 | 1.110 | 1.193 | 1,083 ops/s |
| equality | 5.000 | 4.689 | 4.564 | 5.196 | 5.465 | 212 ops/s |
| nestedEquality | 4.461 | 4.716 | 4.529 | 5.917 | 6.572 | 211 ops/s |
| numericRange | 4.892 | 4.608 | 4.498 | 5.276 | 6.387 | 216 ops/s |
| and | 4.508 | 4.643 | 4.457 | 5.624 | 6.273 | 214 ops/s |
| or | 4.954 | 4.850 | 4.825 | 5.294 | 5.692 | 205 ops/s |
| singleKeyUpdate | 6.685 | 5.303 | 5.222 | 5.773 | 6.543 | 188 ops/s |
| indexedKeyUpdate | 6.541 | 5.496 | 5.399 | 6.598 | 6.889 | 182 ops/s |
| numericIncrement | 6.397 | 5.505 | 5.310 | 6.246 | 7.674 | 181 ops/s |
| singleDelete | 8.145 | 5.216 | 5.006 | 5.555 | 6.708 | 191 ops/s |

| Sustained mode | Concurrency | ops/s | p50 ms | p95 ms | p99 ms | Client CPU | CockroachDB CPU |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 1,073 ops/s | 0.853 | 1.257 | 1.984 | 27.929% | 102.784% |
| write | 1 | 231 ops/s | 4.999 | 5.640 | 7.306 | 7.112% | 72.183% |
| mixed | 1 | 332 ops/s | 2.789 | 5.258 | 6.196 | 9.085% | 56.565% |
| read | 8 | 2,143 ops/s | 2.690 | 4.227 | 6.097 | 37.989% | 142.533% |
| write | 8 | 591 ops/s | 11.000 | 14.861 | 17.416 | 8.229% | 117.089% |
| mixed | 8 | 713 ops/s | 6.807 | 11.638 | 13.668 | 11.785% | 108.473% |

| Trial | Status | Failure / skip reason |
| ---: | --- | --- |
| - | all passed | - |
## 100,000 documents

- Trials: 5/5 passed; fixture SHA-256: `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b`.
- Table setup: 119.186 ms; secondary index setup on empty table: 6048.762 ms.
- First row create: 18.127 ms; bulk insert with indexes maintained: 17519.972 ms (5,708 ops/s).
- CockroachDB RSS idle/loaded/peak: 1376.33 MiB / 1498.30 MiB / 1503.20 MiB; client Node RSS idle/loaded/peak: 62.19 MiB / 145.60 MiB / 157.41 MiB.
- Pebble node-store bytes (whole single-node store, not per database): 1030.31 MiB.

| Operation | First ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| singleCreate | 3.593 | 2.819 | 2.762 | 3.033 | 4.007 | 354 ops/s |
| uuidRead | 1.361 | 1.106 | 1.053 | 1.443 | 1.702 | 900 ops/s |
| equality | 5.140 | 4.864 | 4.786 | 5.388 | 6.743 | 204 ops/s |
| nestedEquality | 4.587 | 5.012 | 4.714 | 6.360 | 7.511 | 198 ops/s |
| numericRange | 5.351 | 4.322 | 4.251 | 4.667 | 6.047 | 230 ops/s |
| and | 4.905 | 4.661 | 4.540 | 5.465 | 6.015 | 213 ops/s |
| or | 5.000 | 5.060 | 4.923 | 5.640 | 5.810 | 197 ops/s |
| singleKeyUpdate | 5.035 | 3.457 | 3.274 | 4.479 | 5.213 | 289 ops/s |
| indexedKeyUpdate | 5.525 | 3.396 | 3.361 | 3.767 | 4.125 | 294 ops/s |
| numericIncrement | 4.401 | 3.327 | 3.240 | 3.824 | 5.202 | 300 ops/s |
| singleDelete | 3.873 | 3.273 | 3.033 | 3.630 | 4.225 | 305 ops/s |

| Sustained mode | Concurrency | ops/s | p50 ms | p95 ms | p99 ms | Client CPU | CockroachDB CPU |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 1,031 ops/s | 0.888 | 1.346 | 2.033 | 27.219% | 99.795% |
| write | 1 | 298 ops/s | 3.184 | 4.099 | 6.207 | 8.533% | 76.978% |
| mixed | 1 | 477 ops/s | 2.663 | 3.499 | 3.867 | 12.070% | 77.985% |
| read | 8 | 2,105 ops/s | 2.725 | 4.376 | 6.200 | 36.734% | 144.281% |
| write | 8 | 772 ops/s | 8.404 | 13.587 | 19.837 | 10.564% | 139.776% |
| mixed | 8 | 991 ops/s | 5.843 | 8.659 | 11.697 | 16.694% | 139.307% |

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
| 10,000 | CoCreateDB | 3572.970 | 0.027 | 0.281 | 0.181 | yes |
| 10,000 | MongoDB | 732.649 | 0.856 | 2.688 | 2.156 | yes |
| 10,000 | Redis JSON/Search | 1274.288 | 0.236 | 2.320 | 2.206 | yes |
| 10,000 | Couchbase | 4437.136 | 0.432 | 18.608 | 18.039 | yes |
| 10,000 | CouchDB | 1386.015 | 3.578 | 9.857 | 23.350 | yes |
| 100,000 | CoCreateDB | 47243.970 | 0.019 | 0.286 | 0.207 | yes |
| 100,000 | MongoDB | 7091.419 | 0.822 | 2.450 | 2.154 | yes |
| 100,000 | Redis JSON/Search | 12844.029 | 0.206 | 6.123 | 7.793 | yes |
| 100,000 | Couchbase | 40726.827 | 0.425 | 18.200 | 18.257 | yes |
| 100,000 | CouchDB | 13711.895 | 3.681 | 9.955 | 25.942 | yes |

## Raw outputs

Raw trial JSON, manifest, summary, and this report are stored in `/home/ubuntu/Dev/CoCreateJS/modules/db/test/benchmarks/providers/cockroachdb/results/cockroachdb-standard-2026-11-20T14-11-38.139Z`. Provider history appends to [cockroachdb.json](../summary.json).
