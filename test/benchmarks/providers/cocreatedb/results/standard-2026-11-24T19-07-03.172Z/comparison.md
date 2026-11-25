# CoCreateDB 100K unified traversal benchmark comparison

- Baseline: [2026-11-24 17:28 report](../standard-2026-11-24T17-28-40.660Z/report.md).
- Unified traversal: [2026-11-24 19:07 report](report.md).
- Both use fixture v3 hash `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b`, five successful runs, adaptive mode, 25% memory allocation, and the same benchmark harness and host class.
- Change is unified traversal vs baseline. Latency/memory: negative is better. Throughput: positive is better.

| Metric | Baseline | Unified traversal | Change | Result |
| --- | ---: | ---: | ---: | --- |
| Create + index (ms) | 64,040.203 | 75,750.633 | +18.3% | regressed |
| Create ack total (ms) | 62,607.767 | 74,459.114 | +18.9% | regressed |
| UUID read p50 (ms) | 0.045 | 0.065 | +42.9% | regressed |
| Equality p50 (ms) | 1.12 | 0.875 | -21.9% | improved |
| Nested equality p50 (ms) | 1.026 | 0.946 | -7.8% | improved |
| Numeric range p50 (ms) | 0.938 | 0.877 | -6.5% | improved |
| AND p50 (ms) | 6.418 | 5.065 | -21.1% | improved |
| OR p50 (ms) | 3.394 | 2.669 | -21.4% | improved |
| Single-key update p50 (ms) | 0.257 | 0.347 | +35.0% | regressed |
| Indexed-key update p50 (ms) | 0.274 | 0.369 | +35.0% | regressed |
| Numeric increment p50 (ms) | 0.265 | 0.351 | +32.5% | regressed |
| Single delete p50 (ms) | 0.673 | 0.744 | +10.5% | regressed |
| Loaded RSS (MiB) | 723.539 | 733.586 | +1.4% | regressed |
| Peak RSS (MiB) | 858.406 | 898.684 | +4.7% | regressed |
| read throughput C1 (ops/s) | 63,407.402 | 44,759.687 | -29.4% | regressed |
| write throughput C1 (ops/s) | 5,173.118 | 3,530.296 | -31.8% | regressed |
| mixed throughput C1 (ops/s) | 9,816.354 | 6,829.113 | -30.4% | regressed |
| read throughput C8 (ops/s) | 79,431.203 | 54,016.176 | -32.0% | regressed |
| write throughput C8 (ops/s) | 5,172.598 | 3,900.081 | -24.6% | regressed |
| mixed throughput C8 (ops/s) | 10,376.537 | 7,108.742 | -31.5% | regressed |

## Interpretation

Correctness passed in all five runs. The final one-pass callback implementation is functionally unified, but this run does not show a performance win: create/index elapsed time rose about 18%, peak RSS about 4.7%, and sustained throughput fell across most workloads. Equality, nested equality, range, AND, and OR p50 latencies improved in this sample, while UUID reads and updates regressed. Because this is one five-run comparison on a two-logical-CPU host and benchmark timings include the in-process client, treat small differences cautiously; the larger throughput/create deltas warrant investigation before calling the change performance-neutral.

The CRUD handler is invoked per match inside `visitTree`; no matched-leaf array is built. Tree index reconciliation is deferred until `visitMatches` releases its traversal lock. The benchmark does not directly isolate filtered update/delete throughput; its filtered-delete probe covers 25 leaves.
