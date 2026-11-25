# CoCreateDB 100K benchmark comparison

- Baseline: [report](standard-2026-11-24T17-28-40.660Z/report.md)
- Refactored: [report](standard-2026-11-24T18-19-48.274Z/report.md)
- Both runs used the same 100,000-record fixture (SHA-256 79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b), five successful runs, same Node runtime, host class, memory policy and benchmark methodology.
- Percent change is refactored vs baseline. For latency and memory, negative is better; for throughput, positive is better.

| Metric | Baseline | Refactored | Change | Readout |
| --- | ---: | ---: | ---: | --- |
| Create + index lifecycle (ms) | 64,040.203 | 64,679.141 | +1.0% | within 1% |
| Create acknowledgement total (ms) | 62,607.767 | 63,311.136 | +1.1% | regressed |
| UUID read p50 (ms) | 0.045 | 0.049 | +7.3% | regressed |
| Equality read p50 (ms) | 1.12 | 1.346 | +20.2% | regressed |
| Nested equality p50 (ms) | 1.026 | 1.043 | +1.6% | regressed |
| Numeric range p50 (ms) | 0.938 | 1.053 | +12.2% | regressed |
| AND query p50 (ms) | 6.418 | 6.708 | +4.5% | regressed |
| OR query p50 (ms) | 3.394 | 3.559 | +4.9% | regressed |
| Single-key update p50 (ms) | 0.257 | 0.256 | -0.5% | within 1% |
| Indexed-key update p50 (ms) | 0.274 | 0.252 | -7.9% | improved |
| Numeric increment p50 (ms) | 0.265 | 0.253 | -4.5% | improved |
| Single delete p50 (ms) | 0.673 | 0.731 | +8.5% | regressed |
| Loaded RSS (MiB) | 723.539 | 723.727 | +0.0% | within 1% |
| Peak RSS (MiB) | 858.406 | 855.777 | -0.3% | within 1% |
| read throughput C1 (ops/s) | 63,407.402 | 58,387.046 | -7.9% | regressed |
| write throughput C1 (ops/s) | 5,173.118 | 4,763.07 | -7.9% | regressed |
| mixed throughput C1 (ops/s) | 9,816.354 | 9,428.768 | -3.9% | regressed |
| read throughput C8 (ops/s) | 79,431.203 | 73,627.86 | -7.3% | regressed |
| write throughput C8 (ops/s) | 5,172.598 | 5,229.364 | +1.1% | improved |
| mixed throughput C8 (ops/s) | 10,376.537 | 9,959.776 | -4.0% | regressed |

## Interpretation

The shared find/action refactor stayed close to baseline for full create/index lifecycle (+1.0%) and memory (loaded RSS +0.03%; peak RSS -0.34%). Query p50s were mixed: UUID lookup +7.3%, equality +20.2%, nested equality +1.6%, range +12.2%, AND +4.5%, OR +4.9%. Update p50s were effectively unchanged to modestly better (-0.4% to -4.5%). Sustained read throughput was lower by roughly 6-8%; write and mixed throughput varied by workload and concurrency. This benchmark does not establish a performance win; its primary result is the shared selection/action lifecycle without a material create/index or memory regression.

The standard suite filtered bulk-delete probe selects only 25 leaves. There is no filtered-update throughput scenario in this suite yet. Update/delete filter selection snapshots candidate UUID references before mutating the index, so the implementation avoids retaining full leaf objects but is not a bounded-memory resumable cursor.
