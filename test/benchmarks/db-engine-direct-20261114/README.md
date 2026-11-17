# Direct CoCreateDB and MongoDB latency benchmark

This benchmark separates first-call latency from the arithmetic mean of subsequent calls for ID reads, equality reads, range reads, creates, and updates. Defaults are one first call and three subsequent calls per operation.

## What the timings mean

CoCreateDB operations call `db.send()` in-process. They do not include HTTP, Socket, authentication, or CRUD route handling.

- `cocreate-memory` measures foreground object operations with disk and external persistence disabled. The operation sees resident memory state; it does not represent fallback reads or mesh delivery.
- `cocreate-deferred` measures foreground operations with `writeBehind:true`. Object state is applied in memory for the response, while local disk writes are queued. The benchmark extends the persistence debounce/max-wait to 60 seconds to keep background disk writes out of the measured batches, then calls `db.flush()` after the measured create batch and update batch. That flush time includes pending index work and filesystem writes; it is not per-write end-to-end durability time.
- In the current direct `createDB()` implementation, creates still check `_id` uniqueness through the local index/read path. That lookup is included in the write-behind create time; the mode measures the actual current foreground API path, not just allocation and memory insertion.
- `cocreate-os-page-cache-read` measures a process-memory miss when the object's file has been read through native filesystem I/O to warm the OS page cache. Before each timed CoCreateDB read, the harness evicts only that object record from CoCreateDB's JSON cache, while leaving the OS cache alone. This forces each sample through the filesystem read path with a best-effort warm OS cache; the OS may evict pages under pressure, so this cannot guarantee every read avoids physical storage.
- MongoDB uses the Node driver directly. `mongodb-memory-ack` sets `{w:1,j:false}` on each measured write; `mongodb-journal` sets `{w:1,j:true}`. Both include driver, wire protocol, and server round-trip time. MongoDB documentation defines `w:1,j:false` acknowledgment after the write is applied in memory and `j:true` acknowledgment after journal synchronization. These remain server calls, not in-process engine timings.

CoCreateDB `db.flush()` waits for pending index work and completion of queued filesystem writes and rename operations; it does not request an fsync guarantee. Therefore compare it as a separate deferred-persistence metric, not as equivalent to MongoDB's journal durability guarantee. Peer delivery is also not measured by this local fixture.

MongoDB uses unique temporary database names and drops only those databases. CoCreateDB uses temporary directories. The configured Mongo URI is read from `MONGODB_URI` or `/home/ubuntu/CoCreate.config.js`; it is never printed or saved in artifacts.

## Run

Run from `/home/ubuntu/Dev/CoCreateJS/modules/db`:

```bash
node test/benchmarks/db-engine-direct-20261114/benchmark.mjs
```

Use `--dry-run` to inspect the plan without connecting or writing data. Use `--coc-only` to run the CoCreateDB memory, deferred-write, and warm-OS-page-cache modes. `BENCH_DOCS` changes the fixture size; `BENCH_REPEATS` changes the subsequent sample count. The MongoDB account needs permission to create and drop the unique temporary databases.

Each run writes a Markdown report and JSON samples into this directory. Use `--report-only <saved-run.json>` to regenerate Markdown without connecting to a database. Add `--compare-to <previous-run.json>` to include run-to-run deltas for matching CoCreateDB paths and operations. The comparison uses subsequent averages only and labels higher current latency as a positive change.

## Interpretation and limits

The direct local-memory latency comparison is CoCreateDB foreground work against MongoDB's `{w:1,j:false}` acknowledgment path. The report also shows the CoCreateDB warm-OS-page-cache file-read path, MongoDB's warmed fixture reads, MongoDB journal acknowledgment, and CoCreateDB's deferred local flush separately. MongoDB's service does not expose whether a warmed read came from WiredTiger cache, OS page cache, or physical storage. MongoDB read measurements include the client/server round-trip, so they cannot isolate WiredTiger CPU time.

Index definitions are aligned where practical. MongoDB receives single-field indexes for pathname, host, rank, group, revision, payload, organization_id, created.on, and updated.on, plus its built-in `_id` index. CoCreateDB indexes supported document fields automatically. Setup time is recorded separately and is excluded from CRUD latency. No deletes are included.
