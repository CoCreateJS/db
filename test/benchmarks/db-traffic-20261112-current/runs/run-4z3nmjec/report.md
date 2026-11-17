# CoCreateDB benchmark after replication-time splitting

Current source was snapshotted without modifying production files. External persistence/recovery was disabled for every run. All records were synthetic fixtures; no live server restart, live database writes, or MongoDB requests were performed. Source SHA-256 verification passed at completion.

## Full memory/index/distribution comparison

Three current runs and 1 fresh control run of the saved original baseline source. Each uses the same 128 KiB target, 1,000 seed documents, and the previous `per-client-yield-v2` traffic sequence. Runs were sequential to avoid benchmark CPU contention. Values below are medians; ranges are observed run variation, not confidence intervals.

| Workload | Baseline ops/sec | Current ops/sec | Change | Current observed range |
|---|---:|---:|---:|---:|
| id-c1 | 1686.9 | 1624.0 | -3.7% | 1620.9–1633.1 |
| equality-c1 | 1707.3 | 1733.8 | +1.6% | 1682.4–1736.1 |
| range-c1 | 281.8 | 311.9 | +10.7% | 304.2–313.9 |
| create-c16 | 10.3 | 12.4 | +20.2% | 12.1–12.5 |
| update-c16 | 101.6 | 99.9 | -1.7% | 99.5–102.3 |
| mixed-c16 | 73.4 | 84.2 | +14.7% | 82.8–84.5 |

| Latency / traffic | Baseline | Current |
|---|---:|---:|
| equality-c1 median ms | 0.507 | 0.503 |
| equality-c1 p95 ms | 0.785 | 0.750 |
| mixed-c16 median ms | 0.590 | 0.586 |
| mixed-c16 p95 ms | 65.019 | 53.223 |
| mixed-c16 serialized MB | 177.3 | 135.7 |
| mixed-c16 repeated partition frames | 5280.0 | 0.0 |
| mixed-c16 mutation byte-measurement ms | 1451.1 | 0.0 |

Final current runs acknowledged [3, 3, 3] newly delivered partitions and verified [52, 52, 52] retained peer-held partitions. Warm read phases in both versions performed no index writes or structural splits. Read latency therefore measures reuse of completed indexes, not rebuilding. The throughput gains chiefly concern write/index/replication processing. Mutation sizing is zero in the current source; transport encoding still occurs and is included in overall elapsed time.

Current partition frames carry transport UUIDs. Duplicate detection ignores those UUIDs when comparing frame content, so distinct UUIDs cannot hide repeated identical partition data. DB-prepared encodings are reused by the harness rather than encoded a second time. The baseline uses the same harness and serializes normally because it supplies no prepared encoding.

All final 1,300 document revisions were checked against an expected model. ID, host/path equality, range responses and stable recipient references were verified. The simulated peer immediately announces ownership of newly delivered split nodes. Final frames for every retained peer-held partition, including new siblings, were compared with the primary cache. No data-root directory existed in memory-only runs. `structuredClone` throws throughout the core workload.

### Workload and limits

- Actual primary DB code, namespace catalogs, indexes, subscriptions, holder discovery, and JSON replication encoding; one simulated peer. No real network, remote execution, IPC, browser rendering, TLS, or MongoDB. Peer acknowledgment is simulated through the source holder API; actual remote execution and network acknowledgment latency remain outside this fixture.
- Small synthetic documents contain IDs, a long pathname, host array, rank, group and revision. This does not establish throughput for large source files.
- Each run executes 1,000 ID reads, 1,000 equality reads, 100 range reads, 100 creates and 200 updates at concurrency 1, then repeats at concurrency 16, followed by 1,000 mixed operations (70% reads / 20% updates / 10% creates). Sixteen streams share one JavaScript primary; this is not sixteen CPU workers.
- Phases share warmed/growing state. Compare matching phases across versions rather than treating concurrency phases as independent identical fixtures. Throughput includes final `flush()` and its indexing drain.
- Normal scalar mutations do not split. Current path trees can remain shallower because their split target is checked only when sent. Never-sent nodes may exceed 128 KiB. This is the chosen behavior, not a strict byte ceiling.
- Holder caching from the earlier experimental `both`/`all` variants is not part of the current production source; those prototypes are not the baseline in this table.
- Live machine load can vary; each JSON includes Node/CPU information. Results are local measurements, not guarantees.

## Local disk and restart check

A separate current-source fixture created 250 file documents with 1 KiB sources and applied 50 updates. It used local write-behind persistence and `.bytes` sidecars, with external persistence disabled. Seed plus first disk drain took 12299.5 ms.

| Fresh process | First cold equality read ms | Warm equality median ms | Warm equality p95 ms | Warm reads/sec |
|---|---:|---:|---:|---:|
| 1 | 43.044 | 0.513 | 0.849 | 1728.0 |
| 2 | 42.058 | 0.512 | 0.863 | 1724.7 |
| 3 | 42.477 | 0.520 | 0.871 | 1699.9 |

The fixture persisted 838 files (845,964 bytes including accounting files), with 263 sidecars and 575 checked size entries. Every sidecar entry matched filesystem `stat`. Three new Node processes read the saved data; each warmed all 250 documents before timing its 1,000 warm reads; the updated revision and source contents were checked. The first cold read happens before that warmup. The cold figure includes loading namespace catalogs, indexes and the first document from disk, but excludes Node startup/import time and operating-system cold-cache eviction. No disk-cache flush was performed. These figures have no equivalent historical disk baseline.

## Saved historical reference

The original saved baseline run reported 10.5 creates/sec, 100.4 updates/sec and 74.2 mixed operations/sec. The fresh baseline above controls better for this run’s machine conditions. The earlier 95.2 mixed/sec result was an experimental count-splitting plus holder-cache prototype; current code follows the subsequently chosen serialization-time split policy.

## Artifacts and reproduction

Run the complete suite from `/home/ubuntu/Dev/CoCreateJS/modules/db` with one command. Each invocation snapshots the current DB source, runs the frozen baseline and all workloads, and writes a fresh folder under `runs/`:

```bash
python3 test/benchmarks/db-traffic-20261112-current/benchmark.py
```

The runner prints the comparison table and saves Markdown/JSON reports and raw measurements. Allow roughly 5–7 minutes. Use `--dry-run` to inspect the plan or `--summary RUN_DIRECTORY` to display a saved result.

`summary.json` holds extracted comparison results. Individual traffic JSON files contain each phase, percentiles, queue/index counters, tree shape, node sizes and verification counts. `local-disk.json` holds restart measurements. `experimental-sources.tar.gz` contains the exact instrumented current and baseline source copies, without dependencies. The source fingerprint manifest describes uninstrumented production files at the start.

`run-acks.py` executes current/control/current/current sequentially with split acknowledgments; its logs preserve phase output. Snapshot pointers select source copies, each linked to the existing DB dependencies. Use a new trial name to avoid overwriting results:

```bash
BENCH_ACK_SPLITS=1 BENCH_DOCS=1000 BENCH_READS=1000 BENCH_WRITES=100 BENCH_UPDATES=200 BENCH_MIXED=1000 BENCH_TRIAL=another-current node traffic.mjs 128
BENCH_ACK_SPLITS=1 BENCH_VARIANT=baseline BENCH_DOCS=1000 BENCH_READS=1000 BENCH_WRITES=100 BENCH_UPDATES=200 BENCH_MIXED=1000 BENCH_TRIAL=another-control node traffic.mjs 128
node local-disk.mjs
```

Preliminary `current-*` and `control-*` runs lacked acknowledgment of newly split nodes and are excluded from the final comparison; `acked-*` files are the final runs. Only the temporary benchmark sources are instrumented. Production code and recovery configuration are unchanged by this benchmark.
