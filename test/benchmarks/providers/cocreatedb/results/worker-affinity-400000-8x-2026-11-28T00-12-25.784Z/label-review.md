# Label review of the attached 400K benchmark

This is an interpretation of the original attached result, started at 2026-11-28T00:12:25.785Z. Original result.json and report.md are preserved. No workload was rerun for this review.

## Workload-end snapshot

| Resource | Adapter write requests submitted | Filesystem write calls started | Filesystem write calls completed | Files published by rename |
| --- | ---: | ---: | ---: | ---: |
| Leaf documents | 560,024 | 560,024 | 560,024 | 560,024 |
| Index branches | 8,874,440 | 280,202 | 280,150 | 280,111 |

In-memory branch changes are not counted by these metrics. A branch.write request means DB submitted one serialized branch-file version to Disk; repeated pending versions can be replaced before any file write occurs. It is neither an in-memory mutation count nor a completed file-write count.

## Payload labels

- `diskAtEnd.bytesWritten`: **58.02 GB of submitted write payload**, before coalescing. This is not physical EBS traffic.
- Branch payload submitted: **57.33 GB**.
- Payload passed to started branch writeFile calls: **562.51 MB**, after coalescing.
- Payload passed to started leaf writeFile calls: **282.55 MB**.

The original filesystem byte counter increments when a file write starts. Because some writes were still running, it cannot provide an exact completed-byte total. Updated instrumentation records started and completed payload bytes separately.

## Pending is not coalesced

At in-memory index readiness, 400,024 leaf writes had been submitted but only 21,920 writeFile calls had completed. The old leaf requestReductionPercent of 94.52% does not establish a 94.52% coalescing benefit: 580,841 storage requests were still outstanding across resource kinds at that snapshot.

The new report counts replacements and cancellations from explicit adapter responses instead of subtracting completed file writes from submitted requests. Those exact disposition counts cannot be recovered from this older result.

At workload end there were still 1,701 outstanding adapter requests. The snapshot precedes shutdown drain. Passed status means CRUD/indexing checks passed, not that every submitted file was already saved at that instant.

Filesystem API completions and payload bytes are not block-device IOPS, EBS bytes or fsync durability. In the corrected comparison, completed branch write calls (280,150) are fewer than completed leaf write calls (560,024). Branch files are larger on average, so their byte totals need not be smaller.
