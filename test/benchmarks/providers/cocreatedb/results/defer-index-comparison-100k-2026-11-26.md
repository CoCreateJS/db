# 100K index deferral comparison

- Dataset: 100,000 records, one organization (`0000000000000000000186a0`)
- Fixture hash: `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b` in all six runs
- Same benchmark settings: adaptive mode, memory acknowledgement, 40 samples, 10 warmups, 1-second sustained phases, concurrency 1
- Inline runs: [`deferIndex: false`](defer-index-false-100k-2026-11-26/manifest.json)
- Deferred runs: [`deferIndex: true`](defer-index-true-100k-2026-11-26/manifest.json)

| Measure | `deferIndex: false` | `deferIndex: true` | Change |
|---|---:|---:|---:|
| Create acknowledgement time (sum) | 33.00 s | 7.15 s | 78.3% lower |
| Final `flushIndex()` wait | 14.64 s | 56.35 s | 3.85x longer |
| Create plus index elapsed | 48.52 s | 64.37 s | 32.7% longer |
| Incremental RSS | 834 MiB | 933 MiB | 11.9% higher |

All runs passed. Inline timing ranged from 47.48 to 49.52 seconds; deferred timing ranged from 63.90 to 64.64 seconds. The fixture and one-organization scope were identical.

Deferral substantially reduces time spent inside create acknowledgements, but this implementation does not merely run the same indexing path later. With `deferIndex: false`, large `createMany` calls collect index entries and insert them in batches. With `deferIndex: true`, leaves enter `pendingIndex`; the worker drains them in chunks and reconciles each leaf, so the backlog takes longer to process and uses more memory. `flushIndex()` also persists dirty leaves before reconciling pending entries, so its wait includes local leaf writes. The current result is faster acknowledgement, slower completion, and a larger temporary queue.
