# One organization, one million records with natural primary-tree pruning

Status: failed. One organization, 80 primary trees, 25,000 records each (2,000,000 total). Cold set: first 15 trees (375,000 records) filled and indexed before writes move to the remaining 65. At the two-thirds checkpoint (1,333,333 records), writes remain on that active subset. No prune call is made by the benchmark.

Create + index wall time: n/a s. Throughput: n/a records/s. Peak process RSS: n/a MiB.

Natural pruning triggered: no. Trees pruned by ingest end: n/a. Peak Node memory: n/a%. Pending before validation: n/a.

| Phase | Records | Cumulative acknowledged | Elapsed (s) |
| --- | ---: | ---: | ---: |


Correctness: {"message":"Cannot read properties of undefined (reading 'size')","stack":"TypeError: Cannot read properties of undefined (reading 'size')\n    at sample (file:///home/ubuntu/Dev/CoCreateJS/modules/db/test/benchmarks/diagnostics/primary-pruning.mjs:86:90)\n    at file:///home/ubuntu/Dev/CoCreateJS/modules/db/test/benchmarks/diagnostics/primary-pruning.mjs:105:5"}.
