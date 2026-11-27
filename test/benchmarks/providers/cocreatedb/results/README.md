# Current CoCreateDB benchmark results

One newest passing result is retained for each distinct workload. When the same organization count and records per organization were run more than once, the newest run replaces the earlier result. Workloads with the same total records but different organization/record distributions remain separate.

| Workload | Total records | Create + index | Throughput (records/s) | Peak process RSS | Report |
| --- | ---: | ---: | ---: | ---: | --- |
| 10 × 1,000 | 10,000 | 5.95 s | 1,681 | 285.9 MiB | [Report](parallel-organizations-1000-2026-11-27T01-24-10.235Z/report.md) |
| 10,000, one organization | 10,000 | 8.77 s | 1,140 | 264.0 MiB | [Report](standard-2026-11-27T01-25-19.202Z/comparison.md) |
| 100,000, one organization | 100,000 | 89.35 s | 1,119 | 935.6 MiB | [Report](standard-2026-11-26T21-11-41.069Z/report.md) |
| 2 × 100,000 | 200,000 | 155.87 s | 1,283 | 1401.4 MiB | [Report](parallel-organizations-2x100k-2026-11-26T21-15-31.602Z/report.md) |
| 200,000, one organization | 200,000 | 204.96 s | 976 | 1552.0 MiB | [Report](standard-2026-11-26T18-22-05.815Z/report.md) |
| 3 × 100,000 | 300,000 | 200.43 s | 1,497 | 2478.3 MiB | [Report](parallel-organizations-3x100k-2026-11-27T02-28-23.492Z/report.md) |
| 1 × 400,000 | 400,000 | 392.20 s | 1,020 | 2163.0 MiB | [Report](single-organization-400k-2026-11-27T02-35-21.844Z/report.md) |
| 16 × 25,000 | 400,000 | 231.57 s | 1,727 | 2852.9 MiB | [Report](parallel-organizations-16x25k-2026-11-27T02-53-13.516Z/report.md) |
| 4 × 100,000 | 400,000 | 262.44 s | 1,524 | 2750.4 MiB | [Report](parallel-organizations-4x100k-2026-11-27T02-11-27.956Z/report.md) |
| 40 × 10,000 | 400,000 | 227.99 s | 1,754 | 2827.0 MiB | [Report](parallel-organizations-40x10k-2026-11-27T03-02-12.476Z/report.md) |
| 8 × 50,000 | 400,000 | 239.81 s | 1,668 | 3000.5 MiB | [Report](parallel-organizations-8x50k-2026-11-27T02-47-01.100Z/report.md) |
| 5 × 100,000 | 500,000 | 339.01 s | 1,475 | 3125.0 MiB | [Report](parallel-organizations-5x100k-2026-11-27T02-18-07.582Z/report.md) |
| 8 × 100,000 | 800,000 | 670.57 s | 1,193 | 4152.3 MiB | [Report](parallel-organizations-8x100k-2026-11-26T21-58-36.676Z/report.md) |
| 10 × 100,000 | 1,000,000 | 927.76 s | 1,078 | 5422.9 MiB | [Report](parallel-organizations-10x100k-2026-11-27T01-30-11.568Z/report.md) |

The parallel diagnostics use one Node process, concurrent organization Trees, and separate organization directories. Their per-organization timings overlap and must not be summed. They measure create plus index drain, include telemetry and local disk writes, and do not include the standard sustained workload. The 10K standard comparison is a single run on each side; see its report for the comparison limits. These are single-host diagnostics, not multi-node cluster benchmarks. Raw results and run manifests are stored alongside each report.
