# Provider specs

Reference data, not executable tests. Keep historical measurements and published examples distinct from same-fixture measurements. Unknown values are null; do not infer zero.

- `cocreatedb.json`: medians across five raw runs per scenario, 2026-11-19.
- `mongodb.json`: historical project measurements plus the new standardized MongoDB 9.0.8 baseline; historical raw provider output remains unavailable.
- `redis.json`: provisional historical numbers and official examples, plus the new standardized Redis 8.10.3 baseline.

Future provider runs should append dated raw results (do not overwrite history), record versions, hardware, dataset hash and bytes, indexes, result counts, concurrency, transport, durability, latency p50/p95/p99/mean, throughput, CPU, idle/loaded/peak RSS and client memory.

Use the same lifecycle fixture, object projection and index maintenance semantics. Redis String SET/GET and RedisJSON/RediSearch are measured as separate lanes in `redis/`; the String lane is a direct JSON-text key-value model without secondary query indexes. The JSON/Search lane records its field indexes and covers indexed query operations. MongoDB's standalone adapter is in `mongodb/` and records its explicit indexes, WiredTiger cache, server and client costs. Measure in-process CoCreateDB and a transport-inclusive CoCreateDB variant separately. Match durability and concurrency before ranking. Compare batch creation separately from single writes. WiredTiger cache capacity, Redis allocator memory, and Node RSS are distinct metrics.

Redis's server package and modules are checksum-verified and extracted by the isolated adapter into the user cache; MongoDB's server binary is downloaded by its isolated test adapter into the user cache. Neither adapter installs database software system-wide or changes production dependencies. Couchbase, CouchDB and CockroachDB have not been run under the standardized suite.

From the module root, install the isolated benchmark dependencies and run MongoDB once to produce its dated baseline:

```sh
npm ci --prefix test/benchmarks/providers/mongodb
npm run benchmark --prefix test/benchmarks/providers/mongodb
```

Run the Redis baseline in both storage modes:

```sh
npm ci --prefix test/benchmarks/providers/redis
npm run benchmark --prefix test/benchmarks/providers/redis
```
