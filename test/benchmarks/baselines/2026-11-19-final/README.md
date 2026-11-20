# Final checkpoint benchmark

Node v22.16.0, Linux x64, 1,000 records, 40 measured samples per query, 10 warmups, five independent processes per version per scenario. Medians of run metrics, milliseconds except memory. Baseline persistence-ready already excludes distribution and uses no-op persistence hooks; final excludes hooks and returns update snapshots. No external persistence, network or workflow costs. Same deterministic fixture. Short tests are noisy; differences are not necessarily significant.

## Fresh

| Metric | Before | Final | Change |
|---|---:|---:|---:|
| Create + index | 74.0402 | 75.3782 | +1.8% |
| UUID read p50 | 0.0046 | 0.0045 | -1.5% |
| Equality p50 | 0.1135 | 0.1102 | -2.9% |
| Nested p50 | 0.1275 | 0.1275 | -0.0% |
| Range p50 | 0.2434 | 0.2118 | -13.0% |
| Update p50 | 0.0283 | 0.0318 | +12.5% |
| Delete 25 | 0.8338 | 0.7866 | -5.7% |
| Total wall | 118.3742 | 117.7365 | -0.5% |
| RSS MiB | 45.5273 | 45.9570 | +0.9% |
| Heap MiB | 10.9228 | 11.2105 | +2.6% |

## Restored

| Metric | Before | Final | Change |
|---|---:|---:|---:|
| Create + index | 75.2268 | 76.1780 | +1.3% |
| UUID read p50 | 0.0045 | 0.0045 | -0.5% |
| Equality p50 | 0.1128 | 0.1333 | +18.1% |
| Nested p50 | 0.1268 | 0.2231 | +76.0% |
| Range p50 | 0.2473 | 0.2237 | -9.6% |
| Update p50 | 0.0287 | 0.0319 | +11.2% |
| Delete 25 | 0.8056 | 0.7823 | -2.9% |
| Total wall | 113.5798 | 119.2406 | +5.0% |
| RSS MiB | 45.7188 | 45.5391 | -0.4% |
| Heap MiB | 10.2093 | 10.7901 | +5.7% |

