# Current CoCreateDB baselines

These are the latest retained results for the object-based index queue. Older CoCreateDB runs, diagnostic outputs, and historical baselines were removed. Other providers retain their own results.

| Scenario | Report | Create + index | Status |
| --- | --- | ---: | --- |
| 10K, one organization | [Report](queue-object-10k-2026-11-26T18-18-21/report.md) | 10.50 s | Passed |
| 100K, one organization | [Report](standard-2026-11-26T18-39-36.192Z/report.md) | 96.50 s | Passed |
| 200K, one organization | [Report](standard-2026-11-26T18-22-05.815Z/report.md) | 204.96 s | Passed |
| Two organizations, 100K each, concurrent | [Report](parallel-organizations-100000-2026-11-26T18-45-37.524Z/report.md) | 154.42 s combined | Passed |

Each result is one run. The 10K run uses one-second sustained phases; the 100K and 200K standard runs use five-second phases. The parallel diagnostic measures concurrent ingestion, indexing, storage, and isolation without standard sustained workloads. Compare like scenarios and repeat before treating differences as stable.

The measurements used the working object-queue implementation before its commit; the source revision in raw metadata identifies the preceding committed checkpoint. Raw results and manifests remain beside each report. `summary.json` retains only these standard runs and links the parallel diagnostic through its baseline catalog.
