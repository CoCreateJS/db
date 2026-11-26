# Matched organization Tree comparison

- Dataset: 100,000 records, all assigned to `organization_id` `0000000000000000000186a0`
- Fixture hash: `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b` on both sides
- Settings: adaptive mode, memory acknowledgement, 40 samples, 10 warmups, 1-second sustained phases, concurrency 1
- Previous: shared Tree with the dynamic `$organization_id` root at commit `5ff628a`
- Current: one Tree and disk directory for the organization, with the same `5ff628a` base code

| Run | Shared Tree create + index | Org Tree create + index | Shared acknowledgement | Org acknowledgement | Shared index drain | Org index drain |
|---|---:|---:|---:|---:|---:|---:|
| 1 | 47.69 s | 48.00 s | 32.66 s | 32.35 s | 14.15 s | 14.73 s |
| 2 | 48.73 s | 50.72 s | 32.41 s | 34.35 s | 15.43 s | 15.48 s |
| 3 | 47.99 s | 48.37 s | 32.32 s | 32.92 s | 14.79 s | 14.55 s |
| **Mean** | **48.13 s** | **49.03 s** | **32.46 s** | **33.21 s** | **14.79 s** | **14.92 s** |

Create plus index was 1.9% slower with org-scoped Trees in these three trials. A difference this small is not evidence of a meaningful regression or improvement. Index drain was 0.9% slower. Incremental RSS averaged 900 MiB for the shared Tree and 863 MiB for org-scoped Trees. Sustained throughput was directionally higher with org-scoped Trees (read +10.6%, write +6.5%, mixed +7.0%), though three one-second samples are not enough to treat those modest differences as conclusive.

The earlier comparison against `baseline-dev-100k-2026-11-25` was not a matched code comparison: that baseline was measured from a dirty worktree identified as `b11817c`, while the org-scoped run used `5ff628a` plus uncommitted changes. Its apparent 57% create/index improvement should not be attributed to organization scoping. This rerun isolates the org Tree change against the pre-change code snapshot more closely.
