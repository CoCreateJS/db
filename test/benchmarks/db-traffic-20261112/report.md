# CoCreateDB cache, index, and distribution benchmarks

Production source fingerprints match the starting snapshot. All optimizations below are experiments in isolated source copies; no live records or persistence were used. Existing uncommitted DB work was preserved.

## Findings

- Ordinary leaf growth can use `entries.length`; internal fanout can use `indexes.length`. Internal `length` is a descendant record count, not direct child count. Keep those semantics distinct. Neither requires JSON serialization.
- Full-node JSON byte measurement during mutation is expensive. In the isolated 20,000-entry numeric index, it consumed over 90% of baseline insertion time at the larger targets.
- Increasing the byte threshold alone did not materially improve the full DB traffic fixture. It reduced pathname tree depth but increased bytes serialized for updates.
- Holder caching avoids repeated distribution-tree scans. Coalescing pending partition updates per destination/path eliminates exact duplicate partition frames in this fixture.
- Count-based splitting plus both distribution changes improved full mixed throughput approximately 28%, from 74.2 to 95.2 operations/sec. The remaining write cost warrants further profiling; pure index throughput is not full DB throughput.

## Full DB traffic

Node v24.18.0, AMD EPYC 7571, 2 reported CPUs. Memory-only primary DB with actual indexing, namespace resolution, subscriptions, and one simulated peer serializing JSON. No network, IPC, HTTP, remote peer execution, or rendering. Each run starts with 1,000 documents and ends with 1,300 verified documents.

The sequence contains ID reads, host/pathname equality reads, bounded range reads, creates and updates at concurrency 1 then 16, followed by 1,000 mixed operations (70% reads, 20% updates, 10% creates). Every client yields after each response. Concurrency 16 means 16 client streams on one JavaScript primary. Phases share warmed/growing state; compare identical phases across variants, not concurrency phases as independent fixtures. Throughput includes final indexing drain (`db.flush()`), rather than acknowledgments alone.

| Policy | Equality median ms | Creates/sec (16) | Updates/sec (16) | Mixed/sec (16) | Mixed p95 ms | Mixed serialized MB |
|---|---:|---:|---:|---:|---:|---:|
| Baseline 128 KiB | 0.544 | 10.5 | 100.4 | 74.2 | 65.84 | 177.3 |
| Baseline 300 KiB | 0.493 | 10.4 | 96.8 | 69.4 | 65.67 | 203.8 |
| Baseline 512 KiB | 0.487 | 9.6 | 102.1 | 71.8 | 66.16 | 203.8 |
| Holder cache + coalescing, 128 KiB | 0.562 | 11.3 | 146.9 | 83.6 | 64.00 | 126.2 |
| Counts + holder cache + coalescing | 0.508 | 13.0 | 176.9 | 95.2 | 61.42 | 152.6 |

MB denotes decimal serialized bytes. The baseline 128 KiB mixed phase sent approximately 51.2 MB of exact duplicate partition frames (5,280 packets); both coalescing variants sent zero exact duplicates. Baseline create and update phases required approximately 748 and 224 index reads per operation; holder caching plus coalescing reduced these to approximately 260 and 80.

Pure read phases performed zero index writes, zero size calculations, and zero splits. Thus reads were not rebuilding these indexes in this fixture. DB equality requests still traversed cached nodes repeatedly (about 18 index reads/request); repeated namespace/metadata resolution is a candidate for subsequent profiling.

## Isolated numeric index

20,000 unique numeric entries in deterministic permuted insertion order; 3,000 equality lookups; 1,000 bounded 20-entry scans; 500 remove-and-insert updates. Counts and mapping checks passed. `structuredClone` throws during the benchmark. Memory-only directories were confirmed absent. Baseline is one trial; experimental sizing and count results are medians of three trials with different target order. These are local measurements, not statistical confidence intervals.

| Policy | Target label KiB | Inserts/sec | Updates/sec | Equality median microseconds |
|---|---:|---:|---:|---:|
| base | 128 | 1539 | 1327 | 32.8 |
| base | 300 | 714 | 693 | 34.0 |
| base | 512 | 467 | 310 | 33.1 |
| base | 1024 | 394 | 191 | 23.1 |
| sizing | 128 | 7752 | 3933 | 35.9 |
| sizing | 300 | 7792 | 3881 | 33.1 |
| sizing | 512 | 7691 | 3258 | 33.2 |
| sizing | 1024 | 8928 | 3544 | 28.1 |
| counts | 128 | 11456 | 5462 | 36.6 |
| counts | 300 | 11455 | 5487 | 32.6 |
| counts | 512 | 12257 | 4854 | 31.9 |
| counts | 1024 | 12195 | 5247 | 25.2 |

`sizing` maintains exact incremental array byte accounting in an ephemeral WeakMap. It is a comparison experiment, not a recommendation to retain size metadata. Split-heavy 1/2/4/8 KiB fixtures checked estimates against complete serialization.

`counts` removes byte calculations and splits at the median item count. For this comparison only, leaf limits were derived from the target label using floor(targetBytes/36): 3,640 / 8,533 / 14,563 / 29,127 entries. Internal fanout limit was 64 children. These labels are not actual byte limits, and 36 bytes is not a general record-size estimate. Production configuration should expose explicit entry/child counts. The fixture does not establish a universal default for variable-width keys or large schemas.

## Distribution and reference checks

All seven variant audits passed holder add/remove/cache clearing, in-place recipient sets, stable document references after updates, removal of old pathname matches, old/new holder targeting, queued live values, stable IDs through array/storage rename, delete/recreate lifetime, and absence of filesystem writes.

Full traffic runs also verified expected document revisions and query results. Optimized runs compared final serialized peer frames for initially held partitions with the primary cache. The baseline 128 KiB run predates this additional frame comparison. The simulated peer initially holds existing ordinary partitions; acquisition of newly split sibling partitions is not exercised. Real multi-node transport, restart, concurrent remote mutation, and fault recovery remain outside this benchmark.

## Recommended implementation direction

1. Use configurable entry count and child count for ordinary splitting. Mutate existing arrays and parent references in place.
2. Cache holder lookups with explicit mutation and cache-clear handling; coalesce repeated pending partition updates by destination and scoped path.
3. If a transport-size trigger is required, measure the already serialized outgoing buffer. A structural split must update the DB tree and affected references before replacement frames are encoded and sent. That exceptional split necessarily requires encoding replacement frames; ordinary sends can reuse their first encoding. Transport fragmentation alone must not silently change tree topology.
4. Keep byte-size metadata out of normal catalog updates. Treat oversized indivisible values according to transport capabilities rather than retrying the same structural split indefinitely.
5. Benchmark broader workloads and real peers before selecting defaults or promoting these experiments. Read-path namespace resolution and bounded-range candidate construction are further candidates, not demonstrated optimizations here.

## Artifacts and reproduction

`summary.json` contains extracted results; individual JSON files contain phase percentiles, queue/index metrics, tree shape and cache measurements. Pilot and trial-1 traffic files were exploratory and are excluded from the comparison. `experimental-sources.tar.gz` preserves every instrumented source variant without dependencies. The original source SHA-256 manifest is `source-fingerprints.json`.

Existing `snapshot*.txt` files point to the temporary source copies used for these results. To reproduce after temporary copies expire, extract the archive, symlink each variant's `node_modules` to `/home/ubuntu/Dev/CoCreateJS/modules/db/node_modules`, and update the corresponding snapshot pointer. Dependencies, including the shared distribution utility imported by the traffic harness, must remain compatible.

Run one benchmark at a time from this directory:

```bash
BENCH_DOCS=1000 BENCH_READS=1000 BENCH_WRITES=100 BENCH_UPDATES=200 BENCH_MIXED=1000 BENCH_TRIAL=2 node traffic.mjs 128
BENCH_VARIANT=both BENCH_DOCS=1000 BENCH_READS=1000 BENCH_WRITES=100 BENCH_UPDATES=200 BENCH_MIXED=1000 BENCH_TRIAL=2 node traffic.mjs 128
BENCH_VARIANT=all BENCH_DOCS=1000 BENCH_READS=1000 BENCH_WRITES=100 BENCH_UPDATES=200 BENCH_MIXED=1000 BENCH_TRIAL=2 node traffic.mjs 128
INDEX_VARIANT=counts INDEX_TRIAL=4 node index-only.mjs
node audit.mjs all
```

Traffic commands overwrite their matching result files. Use a new trial label to preserve existing results. `audit.mjs` accepts the variant as its first positional argument.
