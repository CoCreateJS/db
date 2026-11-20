# Redis benchmark results

- Run: `2026-11-20T04-58-00.174Z`; 2026-11-20T04:58:00.174Z to 2026-11-20T05:15:11.069Z.
- Redis 8.10.3; node-redis 5.12.4; source revision: `4dccde14ba2f645043954617648d7a75be326dfa`.
- Runtime: v24.18.0 on linux-x64; CPU AMD EPYC 7571 (2 logical CPUs).
- Workload: 5 independent trials per size and lane; 10 warmups and 40 samples; 5000 ms per sustained mode/concurrency; concurrency 1, 8.
- Both lanes use the same lifecycle fixture v3 and canonical input hash as CoCreateDB and MongoDB. Operations are validated against fixture-derived UUIDs and expected counts before timings are recorded.
- `string` stores the serialized JSON document using Redis String SET/GET and is a direct-key value-store baseline. It has no secondary query index, so query metrics are intentionally unavailable.
- `json-search` stores native JSON documents with JSON.SET/JSON.GET and indexes fixture fields using RediSearch. It covers equality, nested equality, numeric range, AND/OR filters and filtered deletion.
- Each run uses a fresh Redis child and temporary directory; RDB snapshots and AOF are disabled. Redis and the Node client communicate over local TCP. Reported durability therefore differs from durable or replicated deployments.
- Redis server RSS/CPU, client RSS/CPU and Redis allocator memory are reported separately. Disk I/O and Redis persistence costs are not measured. Temporary server directories are removed after each trial.
- The official Ubuntu Redis 8.10.3 packages were checksum-verified and extracted under the user cache. RedisJSON and RediSearch modules from that exact package are loaded into the server process; system packages and application dependencies were not changed.

| Lane | Size | Runs | Fixture hash | Index setup ms | Load/index ms | Redis used memory | Server loaded RSS |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| string | 1,000 | 5/5 | `bc4f84465e1e80b84bf541e527e39516776dc4bc07afb233c45b825b29a846ac` | 0.000 | 19.115 | 1.77 MiB | 24.89 MiB |
| string | 10,000 | 5/5 | `767927150f41a6967e99ab0e05f11128ba4f408f1b9bfc5e1fc753a84119ac8f` | 0.000 | 104.461 | 6.49 MiB | 29.70 MiB |
| string | 100,000 | 5/5 | `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b` | 0.000 | 813.068 | 53.56 MiB | 77.77 MiB |
| json-search | 1,000 | 5/5 | `bc4f84465e1e80b84bf541e527e39516776dc4bc07afb233c45b825b29a846ac` | 1.081 | 133.660 | 2.88 MiB | 27.65 MiB |
| json-search | 10,000 | 5/5 | `767927150f41a6967e99ab0e05f11128ba4f408f1b9bfc5e1fc753a84119ac8f` | 1.190 | 1274.288 | 16.78 MiB | 41.75 MiB |
| json-search | 100,000 | 5/5 | `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b` | 1.106 | 12844.029 | 154.23 MiB | 181.24 MiB |

## string: 1,000 documents

- Trials: 5/5; fixture SHA-256: `bc4f84465e1e80b84bf541e527e39516776dc4bc07afb233c45b825b29a846ac`.
- Redis startup: 96.860 ms; first SET: 0.656 ms; index setup: 0.000 ms.
- Fixture load and index maintenance: 19.115 ms (52,315 ops/s); Redis used memory: 1.77 MiB; server idle/loaded/peak RSS: 24.25 MiB / 24.89 MiB / 24.89 MiB; Node idle/loaded/peak RSS: 91.88 MiB / 95.57 MiB / 142.30 MiB.
- Median CPU per trial: Node 21122.295 ms, Redis 9810.000 ms.
- This lane measures JSON text through Redis String SET/GET; equality, range and secondary-index queries do not apply.

| Operation | First ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| uuidRead | 0.460 | 0.238 | 0.222 | 0.273 | 0.477 | 4,148 ops/s |
| equality | n/a | n/a | n/a | n/a | n/a | n/a |
| nestedEquality | n/a | n/a | n/a | n/a | n/a | n/a |
| numericRange | n/a | n/a | n/a | n/a | n/a | n/a |
| and | n/a | n/a | n/a | n/a | n/a | n/a |
| or | n/a | n/a | n/a | n/a | n/a | n/a |
| singleCreate | 0.433 | 0.234 | 0.224 | 0.277 | 0.290 | 4,250 ops/s |
| singleKeyUpdate | 0.692 | 0.478 | 0.459 | 0.561 | 0.665 | 2,085 ops/s |
| numericIncrement | 0.727 | 0.479 | 0.453 | 0.575 | 0.669 | 2,079 ops/s |
| singleDelete | 0.703 | 0.405 | 0.387 | 0.470 | 0.539 | 2,460 ops/s |

| Sustained workload | In-flight | ops/s | p50 ms | p95 ms | p99 ms | Client CPU | Redis CPU |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 5,746 ops/s | 0.159 | 0.205 | 0.304 | 71.146% | 32.199% |
| write | 1 | 3,164 ops/s | 0.302 | 0.341 | 0.462 | 64.689% | 35.799% |
| mixed | 1 | 4,185 ops/s | 0.275 | 0.332 | 0.373 | 64.731% | 35.598% |
| read | 8 | 33,377 ops/s | 0.218 | 0.256 | 0.346 | 73.159% | 29.000% |
| write | 8 | 17,371 ops/s | 0.433 | 0.498 | 0.670 | 69.914% | 30.999% |
| mixed | 8 | 18,755 ops/s | 0.393 | 0.441 | 0.581 | 68.943% | 31.799% |
## string: 10,000 documents

- Trials: 5/5; fixture SHA-256: `767927150f41a6967e99ab0e05f11128ba4f408f1b9bfc5e1fc753a84119ac8f`.
- Redis startup: 95.263 ms; first SET: 0.651 ms; index setup: 0.000 ms.
- Fixture load and index maintenance: 104.461 ms (95,730 ops/s); Redis used memory: 6.49 MiB; server idle/loaded/peak RSS: 24.26 MiB / 29.70 MiB / 29.70 MiB; Node idle/loaded/peak RSS: 91.79 MiB / 108.13 MiB / 147.39 MiB.
- Median CPU per trial: Node 21301.595 ms, Redis 9830.000 ms.
- This lane measures JSON text through Redis String SET/GET; equality, range and secondary-index queries do not apply.

| Operation | First ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| uuidRead | 0.422 | 0.227 | 0.218 | 0.268 | 0.366 | 4,351 ops/s |
| equality | n/a | n/a | n/a | n/a | n/a | n/a |
| nestedEquality | n/a | n/a | n/a | n/a | n/a | n/a |
| numericRange | n/a | n/a | n/a | n/a | n/a | n/a |
| and | n/a | n/a | n/a | n/a | n/a | n/a |
| or | n/a | n/a | n/a | n/a | n/a | n/a |
| singleCreate | 0.436 | 0.247 | 0.232 | 0.321 | 0.485 | 4,028 ops/s |
| singleKeyUpdate | 0.666 | 0.448 | 0.408 | 0.521 | 1.192 | 2,225 ops/s |
| numericIncrement | 0.676 | 0.413 | 0.396 | 0.439 | 0.764 | 2,413 ops/s |
| singleDelete | 0.736 | 0.455 | 0.372 | 0.841 | 1.898 | 2,195 ops/s |

| Sustained workload | In-flight | ops/s | p50 ms | p95 ms | p99 ms | Client CPU | Redis CPU |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 5,620 ops/s | 0.163 | 0.207 | 0.300 | 71.038% | 32.199% |
| write | 1 | 3,085 ops/s | 0.305 | 0.349 | 0.500 | 64.574% | 35.799% |
| mixed | 1 | 4,162 ops/s | 0.272 | 0.333 | 0.378 | 64.738% | 35.599% |
| read | 8 | 32,651 ops/s | 0.222 | 0.263 | 0.367 | 72.848% | 28.800% |
| write | 8 | 17,140 ops/s | 0.439 | 0.494 | 0.674 | 69.652% | 30.998% |
| mixed | 8 | 18,421 ops/s | 0.400 | 0.447 | 0.564 | 68.898% | 31.798% |
## string: 100,000 documents

- Trials: 5/5; fixture SHA-256: `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b`.
- Redis startup: 97.318 ms; first SET: 0.718 ms; index setup: 0.000 ms.
- Fixture load and index maintenance: 813.068 ms (122,991 ops/s); Redis used memory: 53.56 MiB; server idle/loaded/peak RSS: 24.30 MiB / 77.77 MiB / 77.77 MiB; Node idle/loaded/peak RSS: 93.08 MiB / 139.07 MiB / 154.22 MiB.
- Median CPU per trial: Node 22943.144 ms, Redis 10300.000 ms.
- This lane measures JSON text through Redis String SET/GET; equality, range and secondary-index queries do not apply.

| Operation | First ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| uuidRead | 1.042 | 0.197 | 0.183 | 0.224 | 0.463 | 5,021 ops/s |
| equality | n/a | n/a | n/a | n/a | n/a | n/a |
| nestedEquality | n/a | n/a | n/a | n/a | n/a | n/a |
| numericRange | n/a | n/a | n/a | n/a | n/a | n/a |
| and | n/a | n/a | n/a | n/a | n/a | n/a |
| or | n/a | n/a | n/a | n/a | n/a | n/a |
| singleCreate | 0.412 | 0.222 | 0.190 | 0.234 | 0.572 | 4,461 ops/s |
| singleKeyUpdate | 0.635 | 0.369 | 0.356 | 0.416 | 0.508 | 2,700 ops/s |
| numericIncrement | 0.657 | 0.377 | 0.356 | 0.521 | 0.667 | 2,639 ops/s |
| singleDelete | 0.633 | 0.342 | 0.332 | 0.377 | 0.393 | 2,920 ops/s |

| Sustained workload | In-flight | ops/s | p50 ms | p95 ms | p99 ms | Client CPU | Redis CPU |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 5,715 ops/s | 0.160 | 0.204 | 0.292 | 69.373% | 32.599% |
| write | 1 | 3,156 ops/s | 0.302 | 0.344 | 0.481 | 64.071% | 36.399% |
| mixed | 1 | 4,074 ops/s | 0.270 | 0.341 | 0.469 | 64.469% | 35.599% |
| read | 8 | 32,236 ops/s | 0.224 | 0.267 | 0.388 | 72.026% | 29.000% |
| write | 8 | 16,993 ops/s | 0.442 | 0.524 | 0.716 | 69.237% | 31.200% |
| mixed | 8 | 18,327 ops/s | 0.400 | 0.456 | 0.591 | 68.567% | 31.998% |
## json-search: 1,000 documents

- Trials: 5/5; fixture SHA-256: `bc4f84465e1e80b84bf541e527e39516776dc4bc07afb233c45b825b29a846ac`.
- Redis startup: 97.451 ms; first JSON.SET: 0.551 ms; index setup: 1.081 ms.
- Fixture load and index maintenance: 133.660 ms (7,482 ops/s); Redis used memory: 2.88 MiB; server idle/loaded/peak RSS: 24.30 MiB / 27.65 MiB / 27.65 MiB; Node idle/loaded/peak RSS: 93.53 MiB / 94.80 MiB / 121.11 MiB.
- Median CPU per trial: Node 12429.120 ms, Redis 19000.000 ms.
- This lane measures RedisJSON, RediSearch JSON path indexes, equality, nested equality, numeric range, AND/OR selection and filtered deletion.

| Operation | First ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| uuidRead | 0.996 | 0.256 | 0.240 | 0.293 | 0.373 | 3,858 ops/s |
| equality | 3.871 | 2.388 | 2.263 | 3.565 | 5.814 | 418 ops/s |
| nestedEquality | 1.422 | 1.195 | 1.167 | 1.443 | 1.558 | 835 ops/s |
| numericRange | 2.114 | 2.042 | 1.992 | 2.429 | 2.760 | 489 ops/s |
| and | 2.368 | 1.887 | 1.824 | 2.243 | 2.436 | 530 ops/s |
| or | 1.942 | 1.861 | 1.792 | 2.195 | 2.404 | 537 ops/s |
| singleCreate | 0.623 | 0.372 | 0.362 | 0.406 | 0.425 | 2,680 ops/s |
| singleKeyUpdate | 0.692 | 0.355 | 0.339 | 0.393 | 0.576 | 2,813 ops/s |
| numericIncrement | 0.668 | 0.364 | 0.338 | 0.432 | 0.771 | 2,742 ops/s |
| singleDelete | 0.946 | 0.533 | 0.501 | 0.690 | 0.827 | 1,871 ops/s |

| Sustained workload | In-flight | ops/s | p50 ms | p95 ms | p99 ms | Client CPU | Redis CPU |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 5,106 ops/s | 0.185 | 0.224 | 0.291 | 63.437% | 39.999% |
| write | 1 | 3,222 ops/s | 0.290 | 0.338 | 0.461 | 34.137% | 65.197% |
| mixed | 1 | 3,940 ops/s | 0.285 | 0.334 | 0.383 | 43.503% | 56.600% |
| read | 8 | 25,215 ops/s | 0.292 | 0.341 | 0.470 | 57.138% | 44.199% |
| write | 8 | 6,793 ops/s | 1.112 | 1.419 | 1.735 | 12.856% | 86.799% |
| mixed | 8 | 10,122 ops/s | 0.750 | 0.909 | 1.062 | 22.169% | 78.000% |
## json-search: 10,000 documents

- Trials: 5/5; fixture SHA-256: `767927150f41a6967e99ab0e05f11128ba4f408f1b9bfc5e1fc753a84119ac8f`.
- Redis startup: 99.422 ms; first JSON.SET: 0.553 ms; index setup: 1.190 ms.
- Fixture load and index maintenance: 1274.288 ms (7,848 ops/s); Redis used memory: 16.78 MiB; server idle/loaded/peak RSS: 24.31 MiB / 41.75 MiB / 41.75 MiB; Node idle/loaded/peak RSS: 93.08 MiB / 109.67 MiB / 146.91 MiB.
- Median CPU per trial: Node 12653.222 ms, Redis 20190.000 ms.
- This lane measures RedisJSON, RediSearch JSON path indexes, equality, nested equality, numeric range, AND/OR selection and filtered deletion.

| Operation | First ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| uuidRead | 0.441 | 0.253 | 0.236 | 0.321 | 0.368 | 3,915 ops/s |
| equality | 4.394 | 2.448 | 2.320 | 2.963 | 3.471 | 408 ops/s |
| nestedEquality | 2.436 | 2.027 | 1.941 | 2.479 | 2.988 | 493 ops/s |
| numericRange | 2.505 | 2.298 | 2.206 | 2.580 | 2.830 | 435 ops/s |
| and | 2.245 | 2.195 | 2.116 | 2.579 | 2.830 | 455 ops/s |
| or | 2.438 | 2.279 | 2.182 | 2.723 | 2.886 | 439 ops/s |
| singleCreate | 0.638 | 0.364 | 0.355 | 0.402 | 0.538 | 2,742 ops/s |
| singleKeyUpdate | 0.558 | 0.341 | 0.326 | 0.377 | 0.488 | 2,923 ops/s |
| numericIncrement | 2.456 | 0.343 | 0.321 | 0.398 | 0.467 | 2,903 ops/s |
| singleDelete | 0.837 | 0.497 | 0.478 | 0.560 | 0.621 | 2,006 ops/s |

| Sustained workload | In-flight | ops/s | p50 ms | p95 ms | p99 ms | Client CPU | Redis CPU |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 5,013 ops/s | 0.189 | 0.226 | 0.264 | 63.556% | 39.399% |
| write | 1 | 3,219 ops/s | 0.294 | 0.343 | 0.418 | 34.577% | 65.400% |
| mixed | 1 | 3,910 ops/s | 0.288 | 0.331 | 0.374 | 43.494% | 56.398% |
| read | 8 | 24,285 ops/s | 0.304 | 0.356 | 0.460 | 57.185% | 44.799% |
| write | 8 | 6,757 ops/s | 1.128 | 1.417 | 1.756 | 12.675% | 86.597% |
| mixed | 8 | 10,010 ops/s | 0.762 | 0.936 | 1.088 | 21.976% | 77.800% |
## json-search: 100,000 documents

- Trials: 5/5; fixture SHA-256: `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b`.
- Redis startup: 97.200 ms; first JSON.SET: 0.526 ms; index setup: 1.106 ms.
- Fixture load and index maintenance: 12844.029 ms (7,786 ops/s); Redis used memory: 154.23 MiB; server idle/loaded/peak RSS: 24.30 MiB / 181.24 MiB / 181.24 MiB; Node idle/loaded/peak RSS: 93.53 MiB / 137.73 MiB / 154.26 MiB.
- Median CPU per trial: Node 14475.539 ms, Redis 32900.000 ms.
- This lane measures RedisJSON, RediSearch JSON path indexes, equality, nested equality, numeric range, AND/OR selection and filtered deletion.

| Operation | First ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| uuidRead | 2.548 | 0.211 | 0.206 | 0.237 | 0.252 | 4,683 ops/s |
| equality | 7.953 | 6.313 | 6.123 | 7.045 | 11.678 | 158 ops/s |
| nestedEquality | 4.400 | 3.844 | 3.787 | 4.417 | 4.987 | 260 ops/s |
| numericRange | 7.908 | 7.966 | 7.793 | 8.430 | 9.371 | 125 ops/s |
| and | 6.775 | 6.854 | 6.760 | 7.344 | 8.761 | 146 ops/s |
| or | 9.786 | 9.412 | 9.375 | 9.765 | 10.107 | 106 ops/s |
| singleCreate | 0.680 | 0.354 | 0.348 | 0.393 | 0.455 | 2,816 ops/s |
| singleKeyUpdate | 0.588 | 0.389 | 0.323 | 0.414 | 2.580 | 2,566 ops/s |
| numericIncrement | 18.917 | 0.331 | 0.319 | 0.367 | 0.433 | 3,015 ops/s |
| singleDelete | 0.836 | 0.497 | 0.470 | 0.521 | 0.966 | 2,009 ops/s |

| Sustained workload | In-flight | ops/s | p50 ms | p95 ms | p99 ms | Client CPU | Redis CPU |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 5,077 ops/s | 0.185 | 0.222 | 0.263 | 62.540% | 40.199% |
| write | 1 | 3,210 ops/s | 0.296 | 0.345 | 0.440 | 33.982% | 65.799% |
| mixed | 1 | 3,924 ops/s | 0.289 | 0.331 | 0.365 | 43.236% | 56.598% |
| read | 8 | 24,756 ops/s | 0.299 | 0.347 | 0.409 | 56.048% | 45.000% |
| write | 8 | 6,792 ops/s | 1.124 | 1.392 | 1.746 | 12.485% | 87.196% |
| mixed | 8 | 9,898 ops/s | 0.768 | 0.925 | 1.104 | 21.806% | 78.199% |

## Fixture comparison with CoCreateDB

The CoCreateDB reference is standardized run `2026-11-20T03-22-17.583Z`. Hash equality confirms identical input documents, while execution models differ: CoCreateDB is in-process memory-only; Redis uses RESP over TCP and has Redis process overhead. Redis String has no query index; the JSON/Search lane adds an explicit field index. These measurements should be read by lane and operation rather than collapsed into a single rank.

| Lane | Size | Same fixture hash | Redis UUID p50 ms | CoCreateDB UUID p50 ms | Redis load/index ms | CoCreateDB create/index ms |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| string | 1,000 | true | 0.222 | 0.028 | 19.115 | 316.528 |
| string | 10,000 | true | 0.218 | 0.017 | 104.461 | 3542.687 |
| string | 100,000 | true | 0.183 | 0.018 | 813.068 | 47915.043 |
| json-search | 1,000 | true | 0.240 | 0.028 | 133.660 | 316.528 |
| json-search | 10,000 | true | 0.236 | 0.017 | 1274.288 | 3542.687 |
| json-search | 100,000 | true | 0.206 | 0.018 | 12844.029 | 47915.043 |

## Historical Redis project numbers

Any pre-existing provider figures remain under `historical` in `redis.json`; they are not merged with the shared-fixture measurements because the prior dataset and raw output are not equivalent.

## Raw results

Manifest and individual runs: `/home/ubuntu/Dev/CoCreateJS/modules/db/test/benchmarks/runs/redis-standard-2026-11-20T04-58-00.174Z`. Status: `{"successfulRuns":30,"failedRuns":0,"notAttempted":0}`. Provider data appended to [redis.json](../../providers/redis.json).

## Reproduce

```sh
npm ci --prefix test/benchmarks/providers/redis
npm run benchmark --prefix test/benchmarks/providers/redis
```

Redis 8.10.3 server packages are downloaded and checksum-verified by the runner into `~/.cache/cocreate-db-redis/8.10.3`; nothing is installed system-wide. Defaults are 1K, 10K and 100K documents, five independent trials, 40 samples, 10 warmups, 5-second sustained workloads, and concurrency 1 and 8. Override with positional sizes, `BENCH_RUNS`, `BENCH_SAMPLES`, `BENCH_WARMUPS`, `BENCH_SUSTAIN_MS`, `BENCH_CONCURRENCY`, `REDIS_BENCH_MODES` and `BENCH_OUTPUT_DIR`.

## Failures

No failed trials.
