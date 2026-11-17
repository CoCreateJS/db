# Isolated CoCreateDB comparison — 2026-11-12

The current flat query engine retains the earlier engine's idle speed. Organization/storage scoping adds lookup overhead, but idle rendering remains around 0.22 seconds in this fixture. Deferred primary indexing shifts work from write acknowledgment into the waiting time of a following read. This reproduces contention without MongoDB or worker IPC; it does not reproduce the live 44-second page delay with this small isolated fixture.

## Idle reads and rendering

| Mode | First file read ms | Warm file read median ms | Warm render median ms | Seed + index ms |
| --- | ---: | ---: | ---: | ---: |
| previous-flat | 15.61 | 1.61 | 145.87 | 5143.28 |
| current-flat | 15.43 | 1.62 | 146.45 | 5139.79 |
| current-scoped | 24.22 | 2.39 | 218.64 | 5362.97 |
| previous-primary | 20.51 | 1.63 | 146.00 | 8660.48 |
| current-primary | 38.15 | 2.38 | 218.49 | 10052.58 |
| current-staged-primary | 38.76 | 2.47 | 216.44 | 6037.13 |

Twenty sequential warm file reads and five warm renders per mode. A fresh reader process starts after each temporary fixture is seeded and flushed, so the first file read starts with an empty process cache; the OS disk cache remains warm. The first render follows the component-read samples, so some indexes/component data are already warm. Seeding/indexing is outside measured read/render intervals.

## One write followed by rendering

Each sample creates a new document with 40 extra scalar fields, yields for 10 ms to let scheduled indexing begin, then renders the page. Five samples per mode; the total includes acknowledgment, the yield, and rendering. This is a controlled contention test, not sustained-load throughput.

| Mode | Write acknowledgment median ms | Following render median ms | Total median ms |
| --- | ---: | ---: | ---: |
| previous-flat | 425.78 | 142.59 | 578.77 |
| current-flat | 410.88 | 143.00 | 559.28 |
| current-scoped | 410.34 | 217.18 | 634.33 |
| previous-primary | 636.20 | 143.38 | 783.37 |
| current-primary | 707.65 | 219.07 | 936.98 |
| current-staged-primary | 31.59 | 677.75 | 728.97 |

The staged primary acknowledges writes early, but the next render waits behind the deferred index job. The previous primary completes index work before acknowledging the write. Compare total time as well as acknowledgment: a faster acknowledgment does not mean the indexing work disappeared.

## Isolation and verification

- Direct `db.send()` calls; no CRUD routing, authentication, Socket, worker IPC, remote nodes, or network persistence.
- Primary modes use the production primary DB integration with an EventEmitter server harness. Mesh sends are counted but not delivered. Namespace/distribution bookkeeping remains enabled in these modes.
- External persistence configuration is asserted absent. The live server's persistence configuration is untouched. Local file writes seed disposable fixtures and permit a new process to load them; mixed workloads also write only those fixtures. This is not a diskless benchmark.
- Memory caching enabled, optional additional index cache disabled in every mode. `current-staged-primary` uses local write-behind; the other modes use immediate local fixture writes.
- 73 public App source documents. Root and hero source hashes match the older benchmark. 23 of 71 dependency source hashes match its saved source audit; the differing dependencies are SVG sources. All modes here use exactly the same current source documents.
- All file-read samples return the expected source hash. Every rendered sample across all modes returns the same 120,860-byte body and SHA-256: `22275bc465d00f584291f5ec20f3d8ae599b6fb7c99a3b7136270e97f5d663c0`. Each render makes 114 file reads, including explicit 404 fallback reads.
- Historical HTTP responses were 116,283 bytes and included the full File Server/CRUD/runtime flow. These direct-render results are comparable to each other, not byte-equivalent or directly comparable in latency to historical HTTP measurements.
- The diagnostic live server was stopped during the measured runs to avoid background CPU contention. No existing DB records or source implementation were modified by this benchmark. Temporary DB fixtures were removed after their runs.

## Baseline and reproduction

`previous-*` uses the saved pre-staged primary-memory source snapshot at `/tmp/coc-db-memory-before-chdrhkm1`, also referenced by `/tmp/coc-db-staged-memory-comparison.md`. It is a saved source snapshot, not an asserted clean Git commit. Current modes load the working checkout. All modes use the currently installed Utils and renderer, isolating DB implementation differences.

Run modes sequentially to avoid contention:

```bash
for mode in previous-flat current-flat current-scoped previous-primary current-primary current-staged-primary; do
  node test/benchmarks/db-isolated-20261112/benchmark.mjs "$mode"
done
```

The saved baseline directory must remain available. Raw per-sample timings, source checks, memory retention, and mesh counts are in each mode's JSON file. Console output is retained in matching `.log` files. Source fingerprints are recorded in `source-fingerprints.json`.

Historical full HTTP results: `../db-vs-mongodb-20261112/report.md` (DB median 1,315.84 ms, 20 samples). Additional historical primary/mixed benchmark artifacts remain in `/tmp/coc-db-primary-comparison.md` and `/tmp/coc-db-staged-memory-comparison.md`.

## Follow-up: diagnostic logging feedback

Further live investigation found that Cluster captures console output and persists it to `servers.logs` every 1,500 ms (or at the batch threshold). Verbose CRUD/DB diagnostics therefore create server-record writes and activity records. Deferred index diagnostics can run after the logger recursion guard has been released, producing more captured logs and more writes. This amplified the measured live indexing workload; the 25–44-second traced HTTP runs are not representative of quiet-server performance.

With the old console tracing disabled, three HTTP root requests took 2.235, 2.128, and 2.157 seconds. With tracing changed to bypass console capture, the first request after startup took 6.115 seconds and subsequent requests took 2.240 and 2.275 seconds. After removing temporary tracing and DB startup/retry chatter, the first request took 6.015 seconds and subsequent requests took 2.583 and 2.141 seconds. Every response was HTTP 200, 116,283 bytes, with SHA-256 `c282e9c5bd9af0759b58aac304e753d99431ae392d4874f232ceef899a0da2df`.

Temporary CRUD/DB traces and transaction timing were removed. Repeated index/persistence retry messages were removed; errors remain available in existing pending-status fields, and explicit flush failures still reject. Final event/delivery failures retain error logging. No queue scheduling or index algorithms were changed. The underlying oversized-index failure remains a separate issue to diagnose; silencing retry messages does not repair it. The live server was restarted with tracing disabled.
