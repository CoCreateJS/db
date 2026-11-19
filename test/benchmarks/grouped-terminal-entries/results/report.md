# Grouped terminal index entries — benchmark results

## Workload and baseline

Baseline was captured before the terminal representation changes. Both runs use Node v24.18.0, Linux x64, a 2-vCPU environment, 3,000 entries per index, and 50 timed samples. The workload has three distributions: unique values, high cardinality (three UUIDs per value), and low cardinality (ten values). It measures initial index build, equality/range scans, one-UUID insertion, UUID update (delete plus insert), UUID deletion, serialized index size, and process RSS.

The benchmark calls `createIndex` directly. It has no separate buffered flush operation; an awaited mutation completes its local artifact write. `insertMs` includes building the tree and updating its catalogs. Equality/range scans validate exact returned counts.

## Results

Latency is p50 in milliseconds. Build and serialized-size values are totals for the 3,000-entry index. Final latency values are the median of two 50-sample runs; the raw runs are retained below.

| Cardinality | Metric | Individual pairs | Grouped tuples | Change |
| --- | --- | ---: | ---: | ---: |
| Unique | Build | 58.86 ms | 60.40 ms | +2.6% |
|  | Equality | 0.020 ms | 0.022 ms | +6.5% |
|  | Range | 0.638 ms | 0.733 ms | +14.9% |
|  | UUID insert | 0.076 ms | 0.068 ms | -9.8% |
|  | UUID update | 0.127 ms | 0.137 ms | +7.8% |
|  | UUID delete | 0.038 ms | 0.051 ms | +33.3% |
|  | Serialized bytes | 68,569 | 74,569 | +8.8% |
| High | Build | 50.66 ms | 57.13 ms | +12.8% |
|  | Equality | 0.023 ms | 0.017 ms | -23.7% |
|  | Range | 0.624 ms | 0.822 ms | +31.8% |
|  | UUID insert | 0.036 ms | 0.034 ms | -7.0% |
|  | UUID update | 0.099 ms | 0.100 ms | +1.2% |
|  | UUID delete | 0.047 ms | 0.034 ms | -26.3% |
|  | Serialized bytes | 66,345 | 56,565 | -14.7% |
| Low | Build | 59.09 ms | 53.36 ms | -9.7% |
|  | Equality | 0.321 ms | 0.244 ms | -24.0% |
|  | Range | 1.055 ms | 0.551 ms | -47.7% |
|  | UUID insert | 0.059 ms | 0.031 ms | -46.5% |
|  | UUID update | 0.095 ms | 0.079 ms | -16.7% |
|  | UUID delete | 0.049 ms | 0.043 ms | -12.6% |
|  | Serialized bytes | 60,670 | 48,730 | -19.7% |

Equal-weighted across the three synthetic distributions, serialized index size fell 8.0%; equality p50 fell 22%, range p50 fell 9%, UUID insert p50 fell 22%, and update/delete p50s were approximately flat. Build time was about 1.4% slower on average. Process peak RSS was 77,504 KiB for baseline and 79,624 KiB median across grouped runs (+2.7%); this short process-level measurement is noisier than the serialized-size comparison.

## Decision

Retain grouped terminal tuples. On the mixed workload, they reduce serialized index size and improve the repeated-value equality/range paths and per-UUID mutations. The tradeoff is real: unique-value indexes use more space, and the high-cardinality range p50 was 32% slower in this run. Keep an eye on range-heavy high-cardinality indexes—especially the unique `_id` index—in larger, repeated benchmarks before treating these results as universal.

## Correctness

Grouped-specific tests pass for sorted UUID insertion, duplicate suppression, deletion and empty-group removal, forward/reverse/equality/range scans, count and boundary metadata, and splitting a large duplicate group across segments. Existing split replication tests also pass. Twelve targeted index/query tests passed.

A wider run of the affected legacy test files was not clean (24/44 passed); many failures assert older CRUD fixture/API contracts and were not established as caused by this representation change. The focused terminal/index/query tests listed above are the correctness evidence for this pass.

## Raw results

- Baseline: `baseline.json` and `run-2026-11-19T04-07-34.578Z.json`
- Grouped run 1: `run-2026-11-19T04-15-14.364Z.json`
- Grouped run 2: `run-2026-11-19T04-16-01.058Z.json`
- Runner: `../benchmark.mjs`
