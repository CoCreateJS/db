# Benchmark providers

Each provider directory owns its adapter, database-specific configuration, report generator, append-only `results/summary.json`, and raw dated result directories. Historical runs are retained alongside new runs. CoCreateDB's standard runner and shared fixture/workload definitions remain directly accessible from `test/benchmarks/` and `test/fixtures/`.

The standardized dataset sizes are 10,000, 100,000 and 1,000,000 records. The standard lifecycle fixture v3 and logical workload definitions are shared across providers; database query syntax, indexes, transport, process model and durability are documented per adapter. Historical measurements remain distinct where fixture hashes or methodology differ.

## Provider lanes

- [CoCreateDB](cocreatedb/): in-process, memory-only standard implementation.
- [MongoDB](mongodb/): standalone local MongoDB with its explicit secondary indexes.
- [Redis](redis/): separate String and RedisJSON/RediSearch modes.
- [CouchDB](couchdb/): local isolated server using Mango indexes and query plans.
- [Couchbase](couchbase/): one-node local Community server with a fresh bucket per trial.
- [CockroachDB](cockroachdb/): local single-node SQL lane with typed columns and indexes.

Each summary history is stored at `<provider>/results/summary.json`; raw runs, manifests and generated reports live in timestamped subdirectories beside it. Do not replace prior results. Report comparisons must check fixture hash and account for provider-specific durability, index, process and transport costs.

Install isolated provider dependencies and run a lane from the module root:

```sh
npm ci --prefix test/benchmarks/providers/mongodb
npm run benchmark --prefix test/benchmarks/providers/mongodb
```

Repeat for `redis`, `couchdb`, `couchbase`, or `cockroachdb` as needed. Provider-specific system setup and resource constraints are documented in each adapter README. Completion-based ingestion runs until all records complete; `BENCH_STALL_MS` is an inactivity watchdog, not a total runtime limit. Fixed-duration throughput tests remain separate.
