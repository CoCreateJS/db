# CoCreateDB configurable scope benchmark

- Workload: lifecycle fixture v2, 1,000 records; 40 measured samples per operation after 10 warmups.
- Fixture SHA-256: `25ebce8889cb93e29279301a3681ce66ebe80d5cb0d147387455ad5cddb44e48`
- Runtime: v24.18.0 on linux-x64; 2 CPUs reported.
- Before source: `eb6f63f pre-scope implementation baseline`; after source: `0036d5e57098987ced094709eb78c1435237e2ad scope implementation`.
- After results are averaged across 3 identical runs.
- Raw JSON: [before](before/run-2026-11-19T18-25-25.172Z.json); after: [run-2026-11-19T18-33-24.660Z.json](after/run-2026-11-19T18-33-24.660Z.json), [run-2026-11-19T18-33-25.114Z.json](after/run-2026-11-19T18-33-25.114Z.json), [run-2026-11-19T19-26-18.199Z.json](after/run-2026-11-19T19-26-18.199Z.json).

| Metric | Before | Scoped implementation | Change |
| --- | ---: | ---: | ---: |
| Create + index, 1,000 records | 174.930 ms | 210.883 ms | +20.6% |
| Create throughput | 5,717 ops/s | 4,743 ops/s | -17.0% |
| UUID read cold | 0.455 ms | 1.011 ms | +122.3% |
| UUID read warm p50 | 0.009 ms | 0.123 ms | +1211.7% |
| UUID read warm p95 | 0.030 ms | 0.695 ms | +2228.4% |
| UUID read warm p99 | 0.146 ms | 2.108 ms | +1348.0% |
| UUID read warm throughput | 56,603 ops/s | 4,556 ops/s | -92.0% |
| Equality read cold | 0.494 ms | 1.751 ms | +254.4% |
| Equality read warm p50 | 0.183 ms | 0.325 ms | +77.6% |
| Equality read warm p95 | 0.243 ms | 0.932 ms | +283.8% |
| Equality read warm p99 | 1.133 ms | 2.765 ms | +144.1% |
| Equality read warm throughput | 4,678 ops/s | 2,357 ops/s | -49.6% |
| Nested path read cold | 0.459 ms | 0.545 ms | +18.9% |
| Nested path read warm p50 | 0.136 ms | 0.198 ms | +45.5% |
| Nested path read warm p95 | 0.166 ms | 0.302 ms | +82.2% |
| Nested path read warm p99 | 0.197 ms | 0.383 ms | +94.8% |
| Nested path read warm throughput | 7,445 ops/s | 4,875 ops/s | -34.5% |
| Range read cold | 2.232 ms | 1.638 ms | -26.6% |
| Range read warm p50 | 0.280 ms | 0.567 ms | +102.5% |
| Range read warm p95 | 0.420 ms | 0.787 ms | +87.7% |
| Range read warm p99 | 0.642 ms | 1.853 ms | +188.6% |
| Range read warm throughput | 3,392 ops/s | 1,555 ops/s | -54.2% |
| UUID update cold | 2.210 ms | 2.049 ms | -7.3% |
| UUID update warm p50 | 0.127 ms | 0.200 ms | +56.9% |
| UUID update warm p95 | 0.164 ms | 0.300 ms | +82.9% |
| UUID update warm p99 | 1.815 ms | 0.349 ms | -80.8% |
| UUID update warm throughput | 5,601 ops/s | 4,563 ops/s | -18.5% |
| Delete batch, 25 records | 1.944 ms | 2.606 ms | +34.1% |
| Process CPU user + system | 336.9 ms | 474.3 ms | +40.8% |
| Heap used after workload | 10.36 MiB | 18.37 MiB | +77.3% |
| RSS after workload | 74.86 MiB | 82.77 MiB | +10.6% |

## Interpretation

Both versions use the same fixture hash, record count, query predicates, and benchmark script. The baseline is the pre-scope Next prototype. The scoped version resolves configured parent artifacts before running CRUD and indexes scope relationships, which adds work to each request. Latencies increased in this run series, especially UUID reads; the comparison makes that cost visible for review.

CPU and memory are process-level readings after each workload and vary with runtime garbage collection and host load. These are in-memory prototype measurements; peer distribution and durable persistence remain outside the benchmark. The report does not treat the timing changes as a correctness or production-performance claim.
