# CoCreateDB 100K create cycle comparison

## Result

The new staged-create cycle passed all five CoCreateDB runs with the shared lifecycle fixture v3. The fixture SHA-256 matches the MongoDB and Redis JSON-search 100K fixture exactly: `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b`.

| Measure | CoCreateDB staged create | MongoDB | Redis JSON-search |
| --- | ---: | ---: | ---: |
| 100K create request phase | 57,972 ms acknowledged | 7,091 ms create + index | 12,844 ms create + index |
| Create throughput | 1,725 records/s acknowledged | 14,102 records/s create + index | 7,786 records/s create + index |
| Single-create p50 | 0.893 ms acknowledgement | 0.637 ms create operation | 0.348 ms create operation |
| CoCreate index drain after acknowledgements | 481 ms | included in create + index | included in create + index |
| CoCreate acknowledgement-to-indexed wall time, excluding fixture generation | 58,455 ms | 7,091 ms create + index | 12,844 ms create + index |
| Peak resident memory | 717 MiB, combined DB and benchmark process | 310 MiB server; client peak unavailable | 181 MiB server + 154 MiB client |

The completed CoCreateDB create-and-index cycle was 8.24x slower than MongoDB and 4.55x slower than Redis JSON-search in these saved provider results. Its create-to-indexed wall time improved 25.8% from the previous CoCreateDB 100K synchronous-index baseline (78,676 ms), while peak RSS fell from 852 MiB to 717 MiB. That previous comparison is directional: the new benchmark separates acknowledgement and deferred indexing, so those timings are not identical phases.

## What the acknowledgement number means

CoCreateDB stages every record in the resident leaf map and returns before its deferred index finalization. Its 57,972 ms acknowledgement total is measured across 100 requests of 1,000 records; it is **not** the latency of one create request. At 10K progress checkpoints the index queue had caught up, and the remaining explicit drain after the final batch was 481 ms. Background indexing and local writes still run in the same Node process and compete for event-loop and CPU time, so they affect later acknowledgement latencies even though they are not awaited by the create response.

MongoDB's and Redis's stored `singleCreate` and 100K figures measure their provider benchmark operation, including their own provider/index work. Redis ran with RDB/AOF disabled; MongoDB ran standalone with `w:1, j:false`. CoCreateDB runs in-process and queues local Warm writes. These are identical fixture records, but their durability and execution boundaries differ, so the table is a useful workload comparison rather than a like-for-like durability claim.

## Validation and source results

- CoCreateDB benchmark: 5/5 passed; all 100,000 records acknowledged and indexed.
- Direct UUID read before index drain: passed in every run.
- Fixture hash and record count: passed in every run.
- Pending index count after drain: zero in every run.
- Full test suite: 54 passed, 0 failed.
- MongoDB baseline: 2026-11-20, five successful 100K runs.
- Redis baseline: 2026-11-20, five successful 100K JSON-search runs.

Raw CoCreateDB runs, manifest, source hashes and the benchmark report are in this directory. Provider reports and raw results remain in their existing directories.
