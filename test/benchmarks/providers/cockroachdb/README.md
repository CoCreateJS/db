# CockroachDB benchmark lane

This lane runs the shared lifecycle fixture v3 against CockroachDB's SQL interface using the `pg` Node driver. It prepares a pinned official Linux x64 binary in the user's cache, starts one isolated local single-node cluster, creates fresh SQL databases for each trial, and stops the server at suite completion.

## Run

```sh
npm run benchmark --prefix test/benchmarks/providers/cockroachdb
```

The default suite runs five independent databases each at 10K, 100K, and 1M documents; 40 operation samples, 10 warmups, 5-second sustained read/write/mixed tests, and concurrency 1 and 8. For a correctness smoke run:

```sh
BENCH_RUNS=1 BENCH_SUSTAIN_MS=1000 BENCH_CONCURRENCY=1 \
  npm run benchmark --prefix test/benchmarks/providers/cockroachdb -- 10000
```

The server package is CockroachDB 26.3.5 and is SHA-256 verified before extraction to `$HOME/.cache/cocreate-db-cockroach/26.3.5`. Nothing is installed system-wide. Override `COCKROACH_BENCH_CACHE`, `COCKROACH_PORT`, and `COCKROACH_HTTP_PORT` to use another user cache or free local ports. The server binds to loopback and uses insecure development mode; do not aim this benchmark at a production cluster.

The provider uses the full fixture document in a JSONB column and duplicates selected searchable values into typed columns. It creates five secondary indexes before ingest; CockroachDB maintains them as part of each insert. Query plans use `FORCE_INDEX` hints to measure the intended indexes. Updates modify JSONB and the related typed column in SQL, and direct UUID deletes use the primary key.

CockroachDB runs at its default SERIALIZABLE isolation, with its Pebble store and SQL memory each capped at 512 MiB. This is a single-node, non-replicated run; it does not measure CockroachDB's distributed replication or consensus behavior. CockroachDB's local insecure binary deployment is documented in the official [single-node startup guide](https://www.cockroachlabs.com/docs/stable/start-a-local-cluster.html). SQL index hints are documented in its [index selection guide](https://www.cockroachlabs.com/blog/index-selection-cockroachdb-2/).

Raw runs and generated reports go to `test/benchmarks/providers/cockroachdb/results/standard-*`; provider history appends to `test/benchmarks/providers/cockroachdb/results/summary.json`.
