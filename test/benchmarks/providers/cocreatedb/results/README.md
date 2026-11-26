# Current CoCreateDB benchmark results

This directory retains the latest requested result for each workload: 100K and 200K single-organization standard runs, plus concurrent 100K-per-organization runs with 2, 4, 8, and 10 organizations. Superseded CoCreateDB result folders were removed; the CockroachDB provider history is maintained separately.

| Workload | Total records | Create + index | Throughput | Peak RSS | Report |
| --- | ---: | ---: | ---: | ---: | --- |
| 100K, one organization | 100,000 | 89.35 s | 1,119 records/s | 935 MiB | [Report](standard-2026-11-26T21-11-41.069Z/report.md) |
| 200K, one organization | 200,000 | 204.96 s | 976 records/s | 1,552 MiB | [Report](standard-2026-11-26T18-22-05.815Z/report.md) |
| 2 organizations × 100K | 200,000 | 155.87 s | 1,283 records/s | 1,401 MiB | [Report](parallel-organizations-2x100k-2026-11-26T21-15-31.602Z/report.md) |
| 4 organizations × 100K | 400,000 | 285.03 s | 1,403 records/s | 2,956 MiB | [Report](parallel-organizations-4x100k-2026-11-26T22-55-03.886Z/report.md) |
| 8 organizations × 100K | 800,000 | 670.57 s | 1,193 records/s | 4,152 MiB | [Report](parallel-organizations-8x100k-2026-11-26T21-58-36.676Z/report.md) |
| 10 organizations × 100K | 1,000,000 | 1,091.13 s | 916 records/s | 5,082 MiB | [Report](parallel-organizations-10x100k-2026-11-26T22-22-58.010Z/report.md) |

The 100K and 200K standard results each contain one independent run. The parallel diagnostics also use one Node process, with concurrent organization Trees and separate directories; per-organization durations overlap and must not be added. The 4-, 8-, and 10-organization runs use the approved-branch updates and were launched with `NODE_OPTIONS=--max-old-space-size-percentage=75`. Each parallel report records its own correctness checks.

`summary.json` indexes the retained standard runs and all six result sets. Raw JSON and manifests are stored alongside each report. These are single-host diagnostics, not multi-node cluster benchmarks.
