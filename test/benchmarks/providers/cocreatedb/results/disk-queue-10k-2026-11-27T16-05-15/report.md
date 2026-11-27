# Independent disk queue: matched 10K comparison

Checkpoint: `9246710`; candidate: current uncommitted worktree. Two fresh-process runs per version, run in baseline/candidate order. One organization, one data table, 10,000 supplied UUIDs, lifecycle v3 fixture, 1,000-row requests, routing/terminal size 64, actual local filesystem adapter, Node v24.18.0.

| Mean of two runs | Checkpoint | Independent disk queue | Change |
| --- | ---: | ---: | ---: |
| Create acknowledgement | 1.08 s | 2.50 s | +130.6% |
| Last rank searchable | 8.67 s | 2.68 s | -69.1% |
| Storage complete | 9.00 s | 5.07 s | -43.7% |
| Peak RSS | 313.12 MiB | 282.67 MiB | -9.7% |
| Branch file writes | 7038.00  | 5385.00  | -23.5% |

The candidate makes all records searchable while disk operations remain pending (15,393 queued/in-flight file operations at that observation in both runs). Searchability is checked through an indexed rank query, followed by a complete indexed count after storage finishes. It is not inferred from UUID reads or from changed queue counters.

Acknowledgement regressed in both samples. Independent indexing and writes now progress during subsequent create requests and share CPU/event-loop and filesystem resources with supplied-UUID existence checks. The increased overlap is a plausible contributor, not a proven attribution. This change improves searchability and storage completion; it does not establish an acknowledgement improvement. No create semantics or planner behavior were changed.

`acknowledgementMs` sums time awaiting the ten create requests; searchability/storage timings are wall time from the start and include fixture generation. Storage completion means adapters resolved and both queues drained, without an fsync power-loss guarantee. The first pair overlapped the test suite; the second pair ran without that suite. Both pairs show the same direction. These are small local diagnostic samples, not a clustered throughput claim. File-operation elapsed times in raw reports overlap and must not be summed as wall time.

Existing worker multi-organization reports and uncommitted runner extensions were preserved. Historical aggregate create-and-index timings included disk waits and should not be compared to the candidate index-only pending count.
