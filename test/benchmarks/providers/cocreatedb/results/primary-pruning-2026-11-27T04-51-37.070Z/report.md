# One organization, one million records with natural primary-tree pruning

Status: passed. One organization, 40 primary trees, 25,000 records each (1,000,000 total). Cold set: first 15 trees (375,000 records) filled and indexed before writes move to the remaining 25. At the two-thirds checkpoint (666,666 records), writes remain on that active subset. No prune call is made by the benchmark.

Create + index wall time: 831.91 s. Throughput: 1202 records/s. Peak process RSS: 4877.1 MiB.

Natural pruning triggered: yes. Trees pruned by ingest end: 15. Peak Node memory: 83.07%. Pending before validation: 0.

| Phase | Records | Cumulative acknowledged | Elapsed (s) |
| --- | ---: | ---: | ---: |
| cold-tree preload | 375000 | 375000 | 35.94 |
| two-thirds checkpoint | 291666 | 666666 | 32.72 |
| final third | 333334 | 1000000 | 102.95 |

Correctness: {"exactlyOneMillionRecords":true,"oneOrganization":true,"primaryTreeCountMatched":true,"allPrimaryTreeUuidReads":"passed","allPrimaryTreeIndexedReads":"passed"}.
