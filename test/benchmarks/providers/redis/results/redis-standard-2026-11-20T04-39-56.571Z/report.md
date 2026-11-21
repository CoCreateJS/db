# Redis benchmark results

- Run: `2026-11-20T04-39-56.571Z`; 2026-11-20T04:39:56.571Z to 2026-11-20T04:56:30.870Z.
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
| string | 1,000 | 5/5 | `bc4f84465e1e80b84bf541e527e39516776dc4bc07afb233c45b825b29a846ac` | 0.000 | 18.369 | 1.77 MiB | 24.87 MiB |
| string | 10,000 | 5/5 | `767927150f41a6967e99ab0e05f11128ba4f408f1b9bfc5e1fc753a84119ac8f` | 0.000 | 101.974 | 6.49 MiB | 29.69 MiB |
| string | 100,000 | 5/5 | `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b` | 0.000 | 822.069 | 53.56 MiB | 77.79 MiB |
| json-search | 1,000 | 5/5 | `bc4f84465e1e80b84bf541e527e39516776dc4bc07afb233c45b825b29a846ac` | 1.025 | 67.849 | 2.54 MiB | 27.25 MiB |
| json-search | 10,000 | 5/5 | `767927150f41a6967e99ab0e05f11128ba4f408f1b9bfc5e1fc753a84119ac8f` | 1.173 | 643.442 | 13.41 MiB | 38.26 MiB |
| json-search | 100,000 | 5/5 | `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b` | 1.102 | 6388.239 | 120.68 MiB | 146.80 MiB |

## string: 1,000 documents

- Trials: 5/5; fixture SHA-256: `bc4f84465e1e80b84bf541e527e39516776dc4bc07afb233c45b825b29a846ac`.
- Redis startup: 98.908 ms; first SET: 0.802 ms; index setup: 0.000 ms.
- Fixture load and index maintenance: 18.369 ms (54,439 ops/s); Redis used memory: 1.77 MiB; server idle/loaded/peak RSS: 24.32 MiB / 24.87 MiB / 24.87 MiB; Node idle/loaded/peak RSS: 93.01 MiB / 95.27 MiB / 144.15 MiB.
- Median CPU per trial: Node 21183.396 ms, Redis 9770.000 ms.
- This lane measures JSON text through Redis String SET/GET; equality, range and secondary-index queries do not apply.

| Operation | First ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| uuidRead | 0.406 | 0.238 | 0.221 | 0.302 | 0.315 | 4,144 ops/s |
| equality | n/a | n/a | n/a | n/a | n/a | n/a |
| nestedEquality | n/a | n/a | n/a | n/a | n/a | n/a |
| numericRange | n/a | n/a | n/a | n/a | n/a | n/a |
| and | n/a | n/a | n/a | n/a | n/a | n/a |
| or | n/a | n/a | n/a | n/a | n/a | n/a |
| singleCreate | 0.424 | 0.246 | 0.234 | 0.282 | 0.328 | 4,034 ops/s |
| singleKeyUpdate | 0.656 | 0.479 | 0.454 | 0.544 | 0.832 | 2,084 ops/s |
| numericIncrement | 0.743 | 0.473 | 0.451 | 0.552 | 0.762 | 2,108 ops/s |
| singleDelete | 0.687 | 0.398 | 0.394 | 0.455 | 0.560 | 2,508 ops/s |

| Sustained workload | In-flight | ops/s | p50 ms | p95 ms | p99 ms | Client CPU | Redis CPU |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 5,716 ops/s | 0.160 | 0.206 | 0.304 | 71.253% | 32.199% |
| write | 1 | 3,140 ops/s | 0.303 | 0.344 | 0.469 | 64.894% | 35.600% |
| mixed | 1 | 4,119 ops/s | 0.269 | 0.336 | 0.441 | 65.084% | 35.397% |
| read | 8 | 32,859 ops/s | 0.220 | 0.262 | 0.392 | 73.075% | 28.800% |
| write | 8 | 17,275 ops/s | 0.435 | 0.500 | 0.701 | 69.996% | 30.998% |
| mixed | 8 | 18,552 ops/s | 0.394 | 0.445 | 0.578 | 69.097% | 31.600% |
## string: 10,000 documents

- Trials: 5/5; fixture SHA-256: `767927150f41a6967e99ab0e05f11128ba4f408f1b9bfc5e1fc753a84119ac8f`.
- Redis startup: 100.197 ms; first SET: 0.655 ms; index setup: 0.000 ms.
- Fixture load and index maintenance: 101.974 ms (98,064 ops/s); Redis used memory: 6.49 MiB; server idle/loaded/peak RSS: 24.26 MiB / 29.69 MiB / 29.69 MiB; Node idle/loaded/peak RSS: 93.27 MiB / 111.26 MiB / 153.11 MiB.
- Median CPU per trial: Node 21332.005 ms, Redis 9860.000 ms.
- This lane measures JSON text through Redis String SET/GET; equality, range and secondary-index queries do not apply.

| Operation | First ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| uuidRead | 0.496 | 0.227 | 0.218 | 0.265 | 0.319 | 4,350 ops/s |
| equality | n/a | n/a | n/a | n/a | n/a | n/a |
| nestedEquality | n/a | n/a | n/a | n/a | n/a | n/a |
| numericRange | n/a | n/a | n/a | n/a | n/a | n/a |
| and | n/a | n/a | n/a | n/a | n/a | n/a |
| or | n/a | n/a | n/a | n/a | n/a | n/a |
| singleCreate | 0.432 | 0.251 | 0.227 | 0.313 | 0.528 | 3,954 ops/s |
| singleKeyUpdate | 0.679 | 0.465 | 0.409 | 0.704 | 1.278 | 2,145 ops/s |
| numericIncrement | 0.709 | 0.418 | 0.397 | 0.452 | 0.632 | 2,387 ops/s |
| singleDelete | 0.695 | 0.425 | 0.374 | 0.537 | 1.358 | 2,348 ops/s |

| Sustained workload | In-flight | ops/s | p50 ms | p95 ms | p99 ms | Client CPU | Redis CPU |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 5,698 ops/s | 0.160 | 0.205 | 0.286 | 71.274% | 31.999% |
| write | 1 | 3,153 ops/s | 0.302 | 0.342 | 0.459 | 64.816% | 35.999% |
| mixed | 1 | 4,139 ops/s | 0.270 | 0.335 | 0.372 | 64.776% | 35.598% |
| read | 8 | 32,479 ops/s | 0.222 | 0.263 | 0.369 | 72.801% | 28.799% |
| write | 8 | 17,257 ops/s | 0.437 | 0.487 | 0.640 | 69.700% | 31.000% |
| mixed | 8 | 18,250 ops/s | 0.399 | 0.454 | 0.596 | 68.615% | 31.800% |
## string: 100,000 documents

- Trials: 5/5; fixture SHA-256: `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b`.
- Redis startup: 96.462 ms; first SET: 0.637 ms; index setup: 0.000 ms.
- Fixture load and index maintenance: 822.069 ms (121,644 ops/s); Redis used memory: 53.56 MiB; server idle/loaded/peak RSS: 24.33 MiB / 77.79 MiB / 77.79 MiB; Node idle/loaded/peak RSS: 93.36 MiB / 139.36 MiB / 193.57 MiB.
- Median CPU per trial: Node 23070.981 ms, Redis 10330.000 ms.
- This lane measures JSON text through Redis String SET/GET; equality, range and secondary-index queries do not apply.

| Operation | First ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| uuidRead | 0.489 | 0.197 | 0.181 | 0.229 | 0.401 | 5,014 ops/s |
| equality | n/a | n/a | n/a | n/a | n/a | n/a |
| nestedEquality | n/a | n/a | n/a | n/a | n/a | n/a |
| numericRange | n/a | n/a | n/a | n/a | n/a | n/a |
| and | n/a | n/a | n/a | n/a | n/a | n/a |
| or | n/a | n/a | n/a | n/a | n/a | n/a |
| singleCreate | 0.419 | 0.202 | 0.187 | 0.227 | 0.523 | 4,911 ops/s |
| singleKeyUpdate | 0.563 | 0.363 | 0.354 | 0.393 | 0.483 | 2,745 ops/s |
| numericIncrement | 0.637 | 0.374 | 0.357 | 0.454 | 0.655 | 2,659 ops/s |
| singleDelete | 0.662 | 0.343 | 0.324 | 0.386 | 0.670 | 2,906 ops/s |

| Sustained workload | In-flight | ops/s | p50 ms | p95 ms | p99 ms | Client CPU | Redis CPU |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 5,787 ops/s | 0.159 | 0.199 | 0.273 | 69.451% | 32.799% |
| write | 1 | 3,177 ops/s | 0.301 | 0.340 | 0.442 | 64.321% | 36.198% |
| mixed | 1 | 4,150 ops/s | 0.270 | 0.334 | 0.387 | 64.710% | 35.998% |
| read | 8 | 32,700 ops/s | 0.221 | 0.260 | 0.357 | 72.197% | 29.199% |
| write | 8 | 17,234 ops/s | 0.437 | 0.491 | 0.625 | 69.516% | 31.198% |
| mixed | 8 | 18,411 ops/s | 0.398 | 0.447 | 0.590 | 68.708% | 31.800% |
## json-search: 1,000 documents

- Trials: 5/5; fixture SHA-256: `bc4f84465e1e80b84bf541e527e39516776dc4bc07afb233c45b825b29a846ac`.
- Redis startup: 99.786 ms; first JSON.SET: 0.592 ms; index setup: 1.025 ms.
- Fixture load and index maintenance: 67.849 ms (14,739 ops/s); Redis used memory: 2.54 MiB; server idle/loaded/peak RSS: 24.28 MiB / 27.25 MiB / 27.25 MiB; Node idle/loaded/peak RSS: 93.39 MiB / 94.52 MiB / 122.10 MiB.
- Median CPU per trial: Node 15739.494 ms, Redis 15760.000 ms.
- This lane measures RedisJSON, RediSearch JSON path indexes, equality, nested equality, numeric range, AND/OR selection and filtered deletion.

| Operation | First ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| uuidRead | 0.550 | 0.255 | 0.240 | 0.308 | 0.374 | 3,879 ops/s |
| equality | 3.847 | 2.354 | 2.289 | 2.934 | 3.225 | 424 ops/s |
| nestedEquality | 1.506 | 1.262 | 1.225 | 1.509 | 1.646 | 791 ops/s |
| numericRange | 2.270 | 2.027 | 1.971 | 2.639 | 2.831 | 493 ops/s |
| and | 2.157 | 1.988 | 1.935 | 2.346 | 2.556 | 503 ops/s |
| or | 2.127 | 1.951 | 1.918 | 2.303 | 2.658 | 512 ops/s |
| singleCreate | 0.590 | 0.310 | 0.297 | 0.358 | 0.423 | 3,215 ops/s |
| singleKeyUpdate | 0.762 | 0.545 | 0.517 | 0.588 | 0.930 | 1,832 ops/s |
| numericIncrement | 0.785 | 0.328 | 0.292 | 0.484 | 1.116 | 3,034 ops/s |
| singleDelete | 0.788 | 0.444 | 0.421 | 0.473 | 0.655 | 2,248 ops/s |

| Sustained workload | In-flight | ops/s | p50 ms | p95 ms | p99 ms | Client CPU | Redis CPU |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 5,061 ops/s | 0.186 | 0.225 | 0.320 | 63.620% | 39.598% |
| write | 1 | 2,296 ops/s | 0.419 | 0.463 | 0.614 | 49.908% | 50.398% |
| mixed | 1 | 3,195 ops/s | 0.362 | 0.451 | 0.523 | 52.432% | 47.799% |
| read | 8 | 25,092 ops/s | 0.294 | 0.343 | 0.484 | 57.405% | 44.199% |
| write | 8 | 7,971 ops/s | 0.963 | 1.153 | 1.346 | 34.303% | 66.197% |
| mixed | 8 | 10,420 ops/s | 0.711 | 0.818 | 1.011 | 41.579% | 58.798% |
## json-search: 10,000 documents

- Trials: 5/5; fixture SHA-256: `767927150f41a6967e99ab0e05f11128ba4f408f1b9bfc5e1fc753a84119ac8f`.
- Redis startup: 99.125 ms; first JSON.SET: 0.576 ms; index setup: 1.173 ms.
- Fixture load and index maintenance: 643.442 ms (15,541 ops/s); Redis used memory: 13.41 MiB; server idle/loaded/peak RSS: 24.28 MiB / 38.26 MiB / 38.26 MiB; Node idle/loaded/peak RSS: 92.99 MiB / 109.61 MiB / 145.68 MiB.
- Median CPU per trial: Node 15834.316 ms, Redis 16520.000 ms.
- This lane measures RedisJSON, RediSearch JSON path indexes, equality, nested equality, numeric range, AND/OR selection and filtered deletion.

| Operation | First ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| uuidRead | 0.532 | 0.256 | 0.240 | 0.328 | 0.373 | 3,860 ops/s |
| equality | 4.739 | 2.470 | 2.399 | 3.064 | 3.809 | 405 ops/s |
| nestedEquality | 2.877 | 1.965 | 1.913 | 2.283 | 3.093 | 509 ops/s |
| numericRange | 2.434 | 2.391 | 2.369 | 2.680 | 2.983 | 418 ops/s |
| and | 2.269 | 2.384 | 2.351 | 2.879 | 3.149 | 419 ops/s |
| or | 2.730 | 2.487 | 2.336 | 2.902 | 3.324 | 402 ops/s |
| singleCreate | 0.554 | 0.297 | 0.289 | 0.328 | 0.348 | 3,360 ops/s |
| singleKeyUpdate | 0.742 | 0.513 | 0.499 | 0.591 | 0.835 | 1,945 ops/s |
| numericIncrement | 0.629 | 0.273 | 0.261 | 0.324 | 0.382 | 3,650 ops/s |
| singleDelete | 0.775 | 0.436 | 0.417 | 0.474 | 1.341 | 2,285 ops/s |

| Sustained workload | In-flight | ops/s | p50 ms | p95 ms | p99 ms | Client CPU | Redis CPU |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 5,003 ops/s | 0.189 | 0.230 | 0.285 | 63.597% | 39.599% |
| write | 1 | 2,257 ops/s | 0.424 | 0.472 | 0.631 | 49.679% | 50.798% |
| mixed | 1 | 3,154 ops/s | 0.363 | 0.457 | 0.524 | 52.157% | 47.999% |
| read | 8 | 24,333 ops/s | 0.302 | 0.358 | 0.503 | 56.887% | 44.600% |
| write | 8 | 7,829 ops/s | 0.982 | 1.158 | 1.384 | 33.763% | 66.396% |
| mixed | 8 | 10,264 ops/s | 0.726 | 0.813 | 0.974 | 40.735% | 59.595% |
## json-search: 100,000 documents

- Trials: 5/5; fixture SHA-256: `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b`.
- Redis startup: 97.829 ms; first JSON.SET: 0.598 ms; index setup: 1.102 ms.
- Fixture load and index maintenance: 6388.239 ms (15,654 ops/s); Redis used memory: 120.68 MiB; server idle/loaded/peak RSS: 24.32 MiB / 146.80 MiB / 146.80 MiB; Node idle/loaded/peak RSS: 92.66 MiB / 133.05 MiB / 149.81 MiB.
- Median CPU per trial: Node 17619.744 ms, Redis 23200.000 ms.
- This lane measures RedisJSON, RediSearch JSON path indexes, equality, nested equality, numeric range, AND/OR selection and filtered deletion.

| Operation | First ms | Warm mean ms | Warm p50 ms | p95 ms | p99 ms | Warm ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| uuidRead | 0.516 | 0.213 | 0.205 | 0.242 | 0.304 | 4,647 ops/s |
| equality | 7.352 | 5.828 | 5.652 | 6.865 | 8.471 | 172 ops/s |
| nestedEquality | 4.280 | 3.856 | 3.847 | 4.412 | 4.673 | 259 ops/s |
| numericRange | 7.014 | 7.029 | 6.972 | 7.345 | 7.569 | 142 ops/s |
| and | 6.184 | 6.231 | 6.136 | 6.597 | 7.610 | 160 ops/s |
| or | 9.230 | 9.049 | 8.960 | 10.072 | 11.222 | 110 ops/s |
| singleCreate | 0.689 | 0.286 | 0.279 | 0.313 | 0.325 | 3,485 ops/s |
| singleKeyUpdate | 0.748 | 0.487 | 0.474 | 0.517 | 0.648 | 2,051 ops/s |
| numericIncrement | 0.659 | 0.286 | 0.258 | 0.312 | 0.644 | 3,478 ops/s |
| singleDelete | 0.790 | 0.435 | 0.423 | 0.464 | 0.609 | 2,295 ops/s |

| Sustained workload | In-flight | ops/s | p50 ms | p95 ms | p99 ms | Client CPU | Redis CPU |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| read | 1 | 5,034 ops/s | 0.186 | 0.227 | 0.295 | 62.818% | 40.199% |
| write | 1 | 2,291 ops/s | 0.421 | 0.463 | 0.586 | 49.346% | 51.198% |
| mixed | 1 | 3,160 ops/s | 0.364 | 0.457 | 0.513 | 51.889% | 48.399% |
| read | 8 | 24,703 ops/s | 0.300 | 0.349 | 0.465 | 56.240% | 44.998% |
| write | 8 | 7,829 ops/s | 0.982 | 1.158 | 1.377 | 33.448% | 66.596% |
| mixed | 8 | 10,051 ops/s | 0.734 | 0.860 | 1.086 | 40.243% | 59.999% |

## Fixture comparison with CoCreateDB

The CoCreateDB reference is standardized run `2026-11-20T03-22-17.583Z`. Hash equality confirms identical input documents, while execution models differ: CoCreateDB is in-process memory-only; Redis uses RESP over TCP and has Redis process overhead. Redis String has no query index; the JSON/Search lane adds an explicit field index. These measurements should be read by lane and operation rather than collapsed into a single rank.

| Lane | Size | Same fixture hash | Redis UUID p50 ms | CoCreateDB UUID p50 ms | Redis load/index ms | CoCreateDB create/index ms |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| string | 1,000 | true | 0.221 | 0.028 | 18.369 | 316.528 |
| string | 10,000 | true | 0.218 | 0.017 | 101.974 | 3542.687 |
| string | 100,000 | true | 0.181 | 0.018 | 822.069 | 47915.043 |
| json-search | 1,000 | true | 0.240 | 0.028 | 67.849 | 316.528 |
| json-search | 10,000 | true | 0.240 | 0.017 | 643.442 | 3542.687 |
| json-search | 100,000 | true | 0.205 | 0.018 | 6388.239 | 47915.043 |

## Historical Redis project numbers

Any pre-existing provider figures remain under `historical` in `redis.json`; they are not merged with the shared-fixture measurements because the prior dataset and raw output are not equivalent.

## Raw results

Manifest and individual runs: `/home/ubuntu/Dev/CoCreateJS/modules/db/test/benchmarks/providers/redis/results/redis-standard-2026-11-20T04-39-56.571Z`. Status: `{"successfulRuns":30,"failedRuns":0,"notAttempted":0}`. Provider data appended to [redis.json](../summary.json).

## Reproduce

```sh
npm ci --prefix test/benchmarks/providers/redis
npm run benchmark --prefix test/benchmarks/providers/redis
```

Redis 8.10.3 server packages are downloaded and checksum-verified by the runner into `~/.cache/cocreate-db-redis/8.10.3`; nothing is installed system-wide. Defaults are 1K, 10K and 100K documents, five independent trials, 40 samples, 10 warmups, 5-second sustained workloads, and concurrency 1 and 8. Override with positional sizes, `BENCH_RUNS`, `BENCH_SAMPLES`, `BENCH_WARMUPS`, `BENCH_SUSTAIN_MS`, `BENCH_CONCURRENCY`, `REDIS_BENCH_MODES` and `BENCH_OUTPUT_DIR`.

## Failures

No failed trials.
