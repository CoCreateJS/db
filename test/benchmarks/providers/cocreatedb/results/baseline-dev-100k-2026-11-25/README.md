# Current dev 100K baseline

This baseline uses the shared v3 fixture (`79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b`) and three independent successful runs. It is the reference point for subsequent work on the current `dev` implementation before query-planner changes.

- Branch and recorded HEAD: `dev`, `b11817c6f6cc95218cc577e934eca2a38e4d82a7`.
- Worktree state: dirty during measurement. The raw `sourceRevision` names HEAD, not the full measured source tree. The benchmark harness was updated in the worktree to initialize `@cocreate/disk` and pass the adapter into DB, matching the current Disk contract.
- Configuration: adaptive mode, memory acknowledgement, local Disk, 100,000 records, 17 index entries per object, 40 samples, 10 warmups, 1-second sustained phases, concurrency 1.
- Median create plus index lifecycle: 114,849 ms (871 records/s). Median create acknowledgement time: 66,935 ms. Median final index drain: 47,085 ms.
- Peak RSS median: 917.80 MiB. Sustained median throughput: reads 50,053 ops/s, writes 4,983 ops/s, mixed 12,063 ops/s.

The previous three-run `dev` measurement at `e89272fa` had a 104,120 ms median create plus index lifecycle, 70,217 ms create acknowledgement, and 33,081 ms final index drain with the same fixture and nominal benchmark settings. The current lifecycle is about 10.3% slower; acknowledgement is about 4.7% faster, while final drain is about 42.3% slower. Query p50s also increased for nested equality (1.67 to 5.73 ms), numeric range (1.26 to 4.37 ms), AND (5.02 to 9.55 ms), and OR (2.81 to 4.31 ms); UUID read remained about 0.04 ms.

This is a before/after signal, not proof of a single cause. The code and memory-management behavior differ between the revisions, and the current worktree was dirty. Keep the current query planner unchanged for this comparison; use this baseline to evaluate the next targeted performance change.

Raw runs, the manifest, generated report, and provider summary are in this directory and its parent `summary.json`.
