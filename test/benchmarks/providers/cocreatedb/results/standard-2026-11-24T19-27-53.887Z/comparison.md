# CoCreateDB 100K unified traversal benchmark comparison

- Baseline: [2026-11-24 17:28 report](../standard-2026-11-24T17-28-40.660Z/report.md).
- Unified traversal: [2026-11-24 19:27 report](report.md).
- Both use fixture v3 hash `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b`, five successful runs, adaptive mode, 25% memory allocation, same fixture and benchmark harness. Runtime reports show the same CPU model/count and RAM class; kernel release differs.
- Change is unified traversal vs baseline. Latency/memory: negative is better. Throughput: positive is better.

| Metric | Baseline | Unified traversal | Change | Result |
| --- | ---: | ---: | ---: | --- |
| Create + index (ms) | 64,040.203 | 63,129.915 | -1.4% | improved |
| Create ack total (ms) | 62,607.767 | 61,768.117 | -1.3% | improved |
| UUID read p50 (ms) | 0.045 | 0.059 | +30.4% | regressed |
| Equality p50 (ms) | 1.12 | 0.898 | -19.9% | improved |
| Nested equality p50 (ms) | 1.026 | 0.907 | -11.7% | improved |
| Numeric range p50 (ms) | 0.938 | 0.854 | -9.0% | improved |
| AND p50 (ms) | 6.418 | 5.053 | -21.3% | improved |
| OR p50 (ms) | 3.394 | 2.635 | -22.4% | improved |
| Single-key update p50 (ms) | 0.257 | 0.356 | +38.6% | regressed |
| Indexed-key update p50 (ms) | 0.274 | 0.344 | +25.7% | regressed |
| Numeric increment p50 (ms) | 0.265 | 0.361 | +36.2% | regressed |
| Single delete p50 (ms) | 0.673 | 0.748 | +11.1% | regressed |
| Loaded RSS (MiB) | 723.539 | 729.539 | +0.8% | within 1% |
| Peak RSS (MiB) | 858.406 | 880.188 | +2.5% | regressed |
| read throughput C1 (ops/s) | 63,407.402 | 44,234.913 | -30.2% | regressed |
| write throughput C1 (ops/s) | 5,173.118 | 3,465.257 | -33.0% | regressed |
| mixed throughput C1 (ops/s) | 9,816.354 | 6,519.465 | -33.6% | regressed |
| read throughput C8 (ops/s) | 79,431.203 | 53,882.992 | -32.2% | regressed |
| write throughput C8 (ops/s) | 5,172.598 | 3,813.503 | -26.3% | regressed |
| mixed throughput C8 (ops/s) | 10,376.537 | 7,101.356 | -31.6% | regressed |

## Interpretation

All five correctness runs passed. After removing the duplicate supplied-UUID existence lookup, create + index lifecycle is close to baseline. The query p50s are mixed; sustained throughput remains lower across the workloads in this run. This is not yet a performance win. Results are one five-run comparison on a two-logical-CPU host; benchmark client and database share the process, so use the detailed reports and raw runs when interpreting the deltas.

The CRUD handler is invoked per match inside the tree visitor, without materializing a matched-leaf array. Index reconciliation is queued until traversal completes. This standard suite does not isolate filtered update/delete throughput; the filtered-delete probe covers 25 leaves. The Git source revision in manifests is the current HEAD and does not encode these uncommitted working-tree changes.
