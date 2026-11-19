# Grouped terminal index benchmark

Run from the DB repository root:

```sh
BENCH_SAMPLES=50 node test/benchmarks/grouped-terminal-entries/benchmark.mjs 3000
```

The direct index-engine workload creates three 3,000-entry indexes with unique, high-cardinality (three documents per value), and low-cardinality (ten values) distributions. It measures index creation, equality/range scans, UUID insertion, UUID replacement (delete plus insert), UUID deletion, and serialized index bytes. Scan counts are asserted against the source data. Run under `/usr/bin/time -v` to capture process peak RSS.

There is no separate buffered index flush API in `createIndex`; each awaited mutation writes its in-memory/disk artifact before returning. `insertMs` measures the complete batched index build, including its catalog updates.
