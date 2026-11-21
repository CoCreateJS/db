# CouchDB benchmark lane

This lane uses the shared lifecycle fixture v3 and Apache CouchDB's JSON document and Mango query APIs. The benchmark extracts a pinned CouchDB package plus its runtime dependency into the user's cache; it does not install system packages or alter production dependencies. It starts an isolated local server, creates fresh databases for each trial, and stops the server when the suite finishes.

## Run

On Ubuntu 24.04 x86_64 with `dpkg-deb`, `apt-get`, and `ldd` available:

```sh
npm run benchmark --prefix test/benchmarks/providers/couchdb
```

The default suite runs five independent databases each at 10K, 100K, and 1M documents, 40 measured samples and 10 warmups per operation, five-second sustained runs, and concurrency 1 and 8. A smaller smoke run:

```sh
BENCH_RUNS=1 BENCH_SUSTAIN_MS=1000 BENCH_CONCURRENCY=1 \
  npm run benchmark --prefix test/benchmarks/providers/couchdb -- 10000
```

The first run downloads CouchDB 3.5.3 and its pinned SpiderMonkey runtime package to `$HOME/.cache/cocreate-db-couchdb/3.5.3`. Both packages are checksum verified before extraction. No privileged install is performed. Override `COUCHDB_BENCH_CACHE` to use another cache directory. The runner binds only to `127.0.0.1`; `COUCHDB_PORT`, `COUCHDB_URL`, `COUCHDB_USERNAME`, and `COUCHDB_PASSWORD` can override its local endpoint and benchmark credentials. The runner refuses to start if that endpoint is already serving CouchDB.

Outputs are written under `test/benchmarks/providers/couchdb/results/standard-*`: individual raw trial JSON, a manifest, `summary.json`, and `report.md`. Provider history appends to `test/benchmarks/providers/couchdb/results/summary.json`.

## Measurement and data mapping

- Six Mango JSON indexes cover UUID, group plus UUID, nested team plus UUID, numeric rank, group plus active plus UUID, and filtered deletion. Each query pins its intended index and disables fallback; `_explain` plans and result checks are retained.
- CouchDB rejects forcing the group compound index for the `$or` query, so that query uses the ordinary planner. `_explain` shows `_all_docs`, making its timing a full-scan measurement; it is not an indexed-query comparison.
- Index setup on the empty database, bulk ingest with indexes maintained, and index catch-up are separate measurements. The fixture data is identical to the other provider lanes and the fixture hash is recorded.
- CouchDB reserves `_id` as its document key. The stored document key is the fixture's `uuid`, and its application `_id` is stored as `appId`; returned application records restore `_id` from `appId`.
- CouchDB uses MVCC revisions. Update timings include GET of the latest document and PUT of its modified full document; delete timings include fetching `_rev` and DELETE. This extra HTTP operation is part of the provider's normal update/delete contract.
- Sustained tests measure direct document GET and revisioned update operations over local HTTP. The server is standalone, without replication or multi-node durability.

The suite uses the official [CouchDB Mango find API](https://docs.couchdb.org/en/stable/api/database/find.html) and [Ubuntu package installation guidance](https://docs.couchdb.org/en/latest/install/unix.html); it extracts the package files without system installation.
