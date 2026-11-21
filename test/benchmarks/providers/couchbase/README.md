# Couchbase benchmark lane

This lane uses the shared lifecycle fixture v3 and runs Couchbase Server Community with the Node SDK. It creates a fresh 512 MiB bucket, scope, collection, and five query indexes for each independent run. It then loads the fixture, waits for the GSI query index to catch up, verifies equivalent result UUIDs, and measures KV/query operations, indexed writes, deletion, memory, CPU, and sustained read/write/mixed load.

## Local server

Use an isolated Couchbase Server Community 8.0.x instance with Data, Query, and Index services enabled, one node, a 1 GiB data quota, and at least 512 MiB available for the benchmark bucket. Do not point the benchmark at a production cluster: it creates and deletes buckets and requires cluster administrator access. Couchbase Community uses `forestdb` for GSI; set the index storage mode before creating indexes (the runner checks but does not alter this setting):

```sh
curl -u 'Administrator:YOUR-BENCHMARK-PASSWORD' \
  -X POST http://127.0.0.1:8091/settings/indexes \
  -d storageMode=forestdb -d numReplica=0
```

For a new one-node benchmark cluster, start Couchbase and initialize its Data, Query, and Index services and a benchmark-only administrator. With the isolated install used for this run:

```sh
CB="$HOME/.cache/cocreate-db-couchbase/8.0.2-nonroot/install/opt/couchbase"
"$CB/bin/couchbase-server" --start
```

Then initialize the local cluster once (choose your own benchmark-only password):

```sh
CB_USER=Administrator
CB_PASSWORD='CouchbaseBench123!'
curl -X POST http://127.0.0.1:8091/clusterInit \
  --data-urlencode 'hostname=127.0.0.1' \
  --data-urlencode 'services=kv,n1ql,index' \
  --data-urlencode 'memoryQuota=1024' \
  --data-urlencode 'indexMemoryQuota=512' \
  --data-urlencode "username=$CB_USER" \
  --data-urlencode "password=$CB_PASSWORD" \
  --data-urlencode 'port=SAME'
```

Set GSI storage mode with the preceding `curl` command before creating any secondary indexes. Use the Couchbase Server Community package matching your host from the official [Couchbase downloads](https://www.couchbase.com/downloads/). An Ubuntu-compatible RPM can be installed under a user-owned directory using the official [non-root installer](https://docs.couchbase.com/server/current/install/non-root.html); no system-wide installation is needed.

The benchmark runner expects a local server at `couchbase://127.0.0.1` and `http://127.0.0.1:8091`, username `Administrator`, and password `CouchbaseBench123!`. Override with `COUCHBASE_URL`, `COUCHBASE_ADMIN_URL`, `COUCHBASE_USERNAME`, and `COUCHBASE_PASSWORD` when using a dedicated alternate local installation.

## Install and run

The SDK ships prebuilt Linux binaries. In environments that set `ELECTRON_RUN_AS_NODE`, clear that variable for npm installation so the SDK selects its Node N-API prebuild:

```sh
ELECTRON_RUN_AS_NODE= npm ci --prefix test/benchmarks/providers/couchbase
npm run benchmark --prefix test/benchmarks/providers/couchbase
```

The default suite runs five independent buckets per size (10K, 100K, and 1M), with 40 samples, 10 warmups, five-second sustained tests, and concurrency 1 and 8. A smoke run can use:

```sh
BENCH_RUNS=1 BENCH_SUSTAIN_MS=1000 BENCH_CONCURRENCY=1 \
  npm run benchmark --prefix test/benchmarks/providers/couchbase -- 10000
```

Outputs are append-only under `test/benchmarks/providers/couchbase/results/standard-*`; each run includes raw JSON, a manifest, `summary.json`, and `report.md`. The standardized provider summaries append to `test/benchmarks/providers/couchbase/results/summary.json`.

Stop the isolated server when finished:

```sh
"$CB/bin/couchbase-server" --stop
```

## Measurement notes

- Couchbase Server is started once outside the suite and remains running; each independent run creates and deletes its own bucket. Server startup is excluded; server process and OS cache are warm across independent buckets.
- KV document keys equal fixture `uuid`, so UUID reads use direct KV Get. Secondary indexes cover the dynamic query workload: group, nested team, rank range, group plus active, and bulk-delete selection.
- Index setup/readiness and ingest index catch-up are reported separately. Bulk ingest timing includes KV insertion and concurrently maintained GSI work; source fixture generation and hashing are excluded.
- Query correctness uses `RequestPlus` until all fixture documents are visible. Timed reads use `NotBounded`, after the catch-up barrier.
- Durability uses one node, no replicas, no transactions, and the SDK's default (none) durability level. Results are not comparable to replicated or majority-durable Couchbase configurations without matching those guarantees.
- Server RSS sums Couchbase process RSS, which can double-count shared pages. CPU is approximate process tick accounting. The server version reported is captured from the running cluster and may differ if a different compatible 8.0.x server is configured.
