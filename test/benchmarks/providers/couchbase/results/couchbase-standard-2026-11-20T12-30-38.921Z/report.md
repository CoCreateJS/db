# Couchbase standardized benchmark results

- Run ID: `2026-11-20T12-30-38.921Z`; 2026-11-20T12:30:38.921Z to 2026-11-20T12:48:54.529Z.
- Couchbase Server: 8.0.2; Node SDK: 4.7.2; source revision: `3f3bb2f21f8fd2332b6f686bb50cfd8b1a553653`.
- Benchmark source fingerprint: `88be40fe742a829b2c662f6ee8c4662a1f4f21c2f9d6449da2fb0dbf735e0a8b`; component file hashes are in `summary.json`.
- Runtime: v24.18.0 on linux-x64; CPU AMD EPYC 7571 (2 logical CPUs); RAM 7838.21 MiB.
- Method: 5 independent fresh buckets per size; 40 measured samples and 10 warmups per operation; 5000 ms sustained per mode/concurrency.
- Process model: single-node Couchbase Server plus Node SDK over loopback TCP; persistence: Couchbase Couchstore bucket on local filesystem; benchmark bucket deleted after each run; durability: single node, replicaNumber=0, default SDK durability (none), no transactions.
- Couchbase server was started once outside the timed suite and kept running; each run created and deleted a fresh bucket, with the same local server process and OS cache. Server startup is not included.
- This server is Community Edition with Couchstore and ForestDB GSI indexes. Five workload indexes are created before fixture ingest and maintained during writes. Couchbase KV Get uses the document key equal to fixture `uuid`; query scans are SQL++ over GSI with `RequestPlus` catch-up before read tests and `NotBounded` during timed reads.
- Ingest timings cover SDK KV insert request latency and background index maintenance, not index creation. GSI creation/readiness and post-ingest index catch-up are measured separately. A 512 MiB bucket quota is reserved per run; no replicas, transactions, durability level, or external persistence are enabled.
- Server RSS is the sum of resident sizes across discovered Couchbase processes and can double-count shared pages. CPU tick deltas are process-summed, approximate, and may exceed 100% when multiple cores are busy.

| Size | Runs passed | Fixture hash | Index setup ms | GSI ready ms | Index catch-up ms | Bulk create ms | Create ops/s | Server loaded RSS |
| ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 5/5 | `bc4f84465e1e80b84bf541e527e39516776dc4bc07afb233c45b825b29a846ac` | 14326.208 | 15.373 | 315.692 | 509.661 | 1,962 ops/s | 1010.90 MiB |
| 10,000 | 5/5 | `767927150f41a6967e99ab0e05f11128ba4f408f1b9bfc5e1fc753a84119ac8f` | 14368.426 | 14.297 | 318.609 | 4437.136 | 2,254 ops/s | 1085.60 MiB |
| 100,000 | 5/5 | `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b` | 14430.298 | 15.672 | 320.431 | 40726.827 | 2,455 ops/s | 1312.43 MiB |

## 1,000 objects

- Independent runs: 5/5 passed. Fixture hash: `bc4f84465e1e80b84bf541e527e39516776dc4bc07afb233c45b825b29a846ac`.
- Bucket/collection setup is per-run; indexes are established before ingest. GSI online: 15.373 ms; ingest index catch-up: 315.692 ms.
- First object create: 4.656 ms; bulk create: 509.661 ms (1,962 ops/s).
- Couchbase server RSS (idle / loaded / peak sum across server processes): 995.64 MiB / 1010.90 MiB / 1077.83 MiB.
- Client Node RSS (idle / loaded / peak): 126.41 MiB / 126.63 MiB / 149.69 MiB.

| Operation | First ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| singleCreate | 1.034 | 0.821 | 0.806 | 1.223 | 1.443 | 1,214 ops/s |
| uuidRead | 0.817 | 0.454 | 0.427 | 0.608 | 0.856 | 2,165 ops/s |
| equality | 19.687 | 19.363 | 18.641 | 23.721 | 26.452 | 52 ops/s |
| nestedEquality | 11.923 | 11.840 | 11.544 | 13.366 | 18.795 | 84 ops/s |
| numericRange | 18.126 | 18.763 | 18.047 | 25.980 | 26.995 | 53 ops/s |
| and | 20.095 | 18.831 | 18.277 | 23.371 | 26.642 | 53 ops/s |
| or | 20.678 | 22.862 | 20.734 | 29.676 | 55.741 | 44 ops/s |
| singleKeyUpdate | 3.213 | 0.818 | 0.686 | 1.232 | 1.957 | 1,218 ops/s |
| indexedKeyUpdate | 1.258 | 0.998 | 0.851 | 1.636 | 2.994 | 998 ops/s |
| numericIncrement | 1.371 | 0.894 | 0.802 | 1.414 | 1.849 | 1,114 ops/s |
| singleDelete | 1.625 | 0.853 | 0.748 | 1.336 | 2.563 | 1,168 ops/s |

| Sustained mode | In flight | ops/s | p50 ms | p95 ms | p99 ms | Client CPU | Server CPU |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 2,355 ops/s | 0.395 | 0.511 | 0.907 | 86.330% | 27.398% |
| write | 1 | 1,204 ops/s | 0.709 | 1.444 | 2.524 | 55.681% | 123.588% |
| mixed | 1 | 1,479 ops/s | 0.589 | 1.120 | 2.060 | 64.492% | 103.399% |
| read | 8 | 5,021 ops/s | 0.881 | 1.369 | 1.876 | 110.386% | 30.793% |
| write | 8 | 1,839 ops/s | 2.440 | 4.692 | 6.888 | 61.874% | 126.319% |
| mixed | 8 | 2,302 ops/s | 1.931 | 3.673 | 5.645 | 70.051% | 113.598% |

| Run | Status | Failure / skip reason |
| ---: | --- | --- |
| - | all passed | - |
## 10,000 objects

- Independent runs: 5/5 passed. Fixture hash: `767927150f41a6967e99ab0e05f11128ba4f408f1b9bfc5e1fc753a84119ac8f`.
- Bucket/collection setup is per-run; indexes are established before ingest. GSI online: 14.297 ms; ingest index catch-up: 318.609 ms.
- First object create: 4.082 ms; bulk create: 4437.136 ms (2,254 ops/s).
- Couchbase server RSS (idle / loaded / peak sum across server processes): 1066.97 MiB / 1085.60 MiB / 1176.56 MiB.
- Client Node RSS (idle / loaded / peak): 202.07 MiB / 202.07 MiB / 252.73 MiB.

| Operation | First ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| singleCreate | 1.268 | 0.815 | 0.753 | 1.196 | 1.246 | 1,220 ops/s |
| uuidRead | 0.820 | 0.444 | 0.432 | 0.504 | 0.911 | 2,215 ops/s |
| equality | 21.096 | 19.399 | 18.608 | 25.001 | 30.178 | 51 ops/s |
| nestedEquality | 18.003 | 19.226 | 18.325 | 24.819 | 26.116 | 52 ops/s |
| numericRange | 18.403 | 18.479 | 18.039 | 22.210 | 26.481 | 54 ops/s |
| and | 18.299 | 19.168 | 18.539 | 24.873 | 27.747 | 52 ops/s |
| or | 41.389 | 41.338 | 39.686 | 48.779 | 55.908 | 24 ops/s |
| singleKeyUpdate | 3.126 | 0.883 | 0.775 | 1.319 | 1.596 | 1,129 ops/s |
| indexedKeyUpdate | 0.769 | 1.023 | 0.797 | 1.614 | 3.689 | 973 ops/s |
| numericIncrement | 1.668 | 1.008 | 0.761 | 1.905 | 4.197 | 990 ops/s |
| singleDelete | 1.472 | 0.804 | 0.659 | 2.080 | 2.976 | 1,238 ops/s |

| Sustained mode | In flight | ops/s | p50 ms | p95 ms | p99 ms | Client CPU | Server CPU |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 2,357 ops/s | 0.391 | 0.511 | 0.827 | 84.786% | 28.800% |
| write | 1 | 1,242 ops/s | 0.692 | 1.356 | 2.455 | 57.674% | 124.786% |
| mixed | 1 | 1,481 ops/s | 0.579 | 1.120 | 1.962 | 65.222% | 107.988% |
| read | 8 | 5,019 ops/s | 0.923 | 1.331 | 1.681 | 112.013% | 28.399% |
| write | 8 | 1,879 ops/s | 2.362 | 4.667 | 7.263 | 59.870% | 129.146% |
| mixed | 8 | 2,360 ops/s | 1.911 | 3.342 | 5.914 | 70.621% | 112.930% |

| Run | Status | Failure / skip reason |
| ---: | --- | --- |
| - | all passed | - |
## 100,000 objects

- Independent runs: 5/5 passed. Fixture hash: `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b`.
- Bucket/collection setup is per-run; indexes are established before ingest. GSI online: 15.672 ms; ingest index catch-up: 320.431 ms.
- First object create: 5.689 ms; bulk create: 40726.827 ms (2,455 ops/s).
- Couchbase server RSS (idle / loaded / peak sum across server processes): 1310.03 MiB / 1312.43 MiB / 1413.65 MiB.
- Client Node RSS (idle / loaded / peak): 301.81 MiB / 302.18 MiB / 302.75 MiB.

| Operation | First ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| singleCreate | 2.367 | 0.843 | 0.783 | 1.274 | 1.659 | 1,181 ops/s |
| uuidRead | 0.851 | 0.453 | 0.425 | 0.518 | 1.185 | 2,167 ops/s |
| equality | 20.306 | 19.147 | 18.200 | 24.543 | 30.169 | 52 ops/s |
| nestedEquality | 18.097 | 18.619 | 18.028 | 23.298 | 25.708 | 54 ops/s |
| numericRange | 19.759 | 19.044 | 18.257 | 24.067 | 26.653 | 52 ops/s |
| and | 18.969 | 19.797 | 18.471 | 26.713 | 29.164 | 50 ops/s |
| or | 253.267 | 242.852 | 236.501 | 279.117 | 297.867 | 4 ops/s |
| singleKeyUpdate | 3.452 | 1.217 | 1.128 | 2.105 | 2.871 | 816 ops/s |
| indexedKeyUpdate | 1.047 | 1.109 | 1.038 | 1.821 | 2.901 | 893 ops/s |
| numericIncrement | 1.618 | 0.886 | 0.795 | 1.476 | 2.945 | 1,124 ops/s |
| singleDelete | 1.846 | 0.733 | 0.676 | 1.325 | 1.604 | 1,356 ops/s |

| Sustained mode | In flight | ops/s | p50 ms | p95 ms | p99 ms | Client CPU | Server CPU |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 2,277 ops/s | 0.403 | 0.532 | 1.053 | 86.299% | 27.598% |
| write | 1 | 1,229 ops/s | 0.676 | 1.441 | 2.780 | 57.714% | 125.995% |
| mixed | 1 | 1,418 ops/s | 0.595 | 1.201 | 2.302 | 65.079% | 111.390% |
| read | 8 | 4,765 ops/s | 0.881 | 1.528 | 2.679 | 113.792% | 48.798% |
| write | 8 | 1,756 ops/s | 2.475 | 4.904 | 8.470 | 61.925% | 128.383% |
| mixed | 8 | 2,196 ops/s | 1.995 | 3.780 | 6.874 | 72.850% | 115.787% |

| Run | Status | Failure / skip reason |
| ---: | --- | --- |
| - | all passed | - |

## Same-fixture reference comparison

These are the latest existing provider snapshots, not simultaneous controlled runs. Fixture SHA-256 must match to be included. Provider versions/configurations and run windows differ. The creation column adds secondary-index setup to bulk ingest for external providers; CoCreateDB measures in-memory index creation as part of its create path.

| Size | Provider | Bulk create + index setup ms | UUID read p50 ms | Equality p50 ms | Numeric range p50 ms | Fixture match |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1,000 | CoCreateDB (memory) | 317.416 | 0.029 | 0.270 | 0.248 | yes |
| 1,000 | MongoDB | 260.948 | 0.846 | 2.433 | 2.506 | yes |
| 1,000 | Redis JSON/Search | 134.741 | 0.240 | 2.263 | 1.992 | yes |
| 1,000 | Couchbase | 14835.869 | 0.427 | 18.641 | 18.047 | yes |
| 10,000 | CoCreateDB (memory) | 3572.970 | 0.027 | 0.281 | 0.181 | yes |
| 10,000 | MongoDB | 893.188 | 0.856 | 2.688 | 2.156 | yes |
| 10,000 | Redis JSON/Search | 1275.478 | 0.236 | 2.320 | 2.206 | yes |
| 10,000 | Couchbase | 18805.562 | 0.432 | 18.608 | 18.039 | yes |
| 100,000 | CoCreateDB (memory) | 47243.970 | 0.019 | 0.286 | 0.207 | yes |
| 100,000 | MongoDB | 7249.127 | 0.822 | 2.450 | 2.154 | yes |
| 100,000 | Redis JSON/Search | 12845.135 | 0.206 | 6.123 | 7.793 | yes |
| 100,000 | Couchbase | 55157.125 | 0.425 | 18.200 | 18.257 | yes |

## Query-plan observation

At 100,000 documents, OR equality p50 was 236.501 ms. EXPLAIN shows an explicit Order operator after the two GSI spans, likely contributing to the slower OR result.

## Raw results and limits

Raw run JSON, manifest and generated summary are in `/home/ubuntu/Dev/CoCreateJS/modules/db/test/benchmarks/providers/couchbase/results/couchbase-standard-2026-11-20T12-30-38.921Z`. The append-only provider summary is [couchbase.json](../summary.json). The run compares identical fixture content and result UUID ordering; indexes and persistence semantics differ by provider, as documented above.
Couchbase Server Community requires a local install with the Data, Query and Index services enabled, a 1 GiB data quota, and ForestDB index storage mode configured before any GSI indexes are created. This lane does not measure cluster startup, multi-node replication, durability acknowledgements, failover or remote network latency.
