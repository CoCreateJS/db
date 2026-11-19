# CoCreateDB lifecycle benchmark

This runner targets the previous implementation and is retained for
cross-version comparison. On branch `Next`, use
`test/benchmarks/compare-lifecycle.sh`; it copies this runner into a temporary
`dev` worktree and runs it against the old source with the shared v2 fixture.
The historical runs and reports below are preserved as reference data.

Run from the DB repository root:

```sh
node test/benchmarks/db-lifecycle-20261118/benchmark.mjs
```

Pass comma-separated sizes to change the default `100,500,1000` documents. Set
`BENCH_SAMPLES` to change the per-operation sample count (default `40`). Each
run writes a timestamped JSON result under `results/`.

This measures the current scoped CoCreateDB CRUD path in one process with
`memoryOnly: true`. It includes batch create and index-flush time, UUID reads,
indexed equality and nested-path reads, range reads, UUID updates, and a UUID
delete batch. It does not include disk, persistence workflows, network peers,
MongoDB, or IndexedDB. Compare runs on the same host and Node version; these
numbers describe this workload and are not a cross-database comparison.

To measure how much the already-created field catalogs are reused for another
equally sized batch, run:

```sh
node test/benchmarks/db-lifecycle-20261118/index-reuse.mjs 1000
```

That runner performs two create-and-index rounds with the same three fields and
records each flush separately.
