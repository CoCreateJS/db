# Partial 2M one-organization backlog test

**Stopped during final disk drain at the user's request.** The run used the current worktree, one organization, 80 primary Trees × 25,000 records, and the existing 15-cold / 65-active schedule. Node used `--max-old-space-size=23000` (about 75% of this host's RAM); the observed V8 heap limit was 23,192 MiB.

All 2,000,000 records were acknowledged. The index queue reached zero and the benchmark entered the final disk-drain phase. The phase timing logs were: cold preload 76.41 s for 375,000 records; two-thirds checkpoint writes 252.01 s for 958,333 records; final-third writes 208.77 s for 666,667 records. The index-ready timestamp was approximately 1,166,996–1,176,996 ms from workload start (19.45–19.62 minutes); the runner did not emit its exact internal value before it was stopped.

At the latest progress sample (1,226,995 ms), `pendingIndexCount=0`, `pendingDiskCount=918,564`, RSS was 11,398 MiB, all 80 Trees were resident, and pruning had not started. A host I/O sample during checkpoint drain showed about 4,456 NVMe writes/s, 39,068 KiB/s, 53.1% device utilization, and 11.35% CPU I/O wait. Because the disk phase was interrupted, there is no storage-complete timing or post-load read validation. The pending disk metric includes the in-flight batch and only drops at batch boundaries.

The prior default-heap attempt failed at 700,000 acknowledged records with V8 heap exhaustion; its partial report is [here](../primary-pruning-2000000-80x25k-2026-11-27T16-20-00Z/partial-report.md). Raw measurements for this stopped run are in [partial-result.json](partial-result.json).
