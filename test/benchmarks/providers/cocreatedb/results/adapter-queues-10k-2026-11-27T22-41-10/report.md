# Adapter-owned queues: 10K smoke benchmark

One standalone process, one organization and one data table, 10,000 supplied
UUIDs from the lifecycle v3 fixture, ten 1,000-row requests, index size 64 and
terminal size 64, Node v24.18.0, real local filesystem Disk adapter. Both module
revisions and the fixture hash are recorded in result.json; both worktrees were
modified. The test suite overlapped this run.

| Measurement | Result |
| --- | ---: |
| Summed create acknowledgement | 2.477 s |
| Last rank searchable | 2.656 s |
| Storage complete | 4.670 s |
| Peak sampled process RSS | 322.3 MiB |

Searchability was observed through an indexed query for rank 9999. Storage
completion waited for owned adapter request promises; a final full indexed
query returned all 10,000 records. Timings are wall time from creation start,
except acknowledgement, which sums the create request waits. Queue observation
is test coordination, never a barrier in CRUD reads.

This is a smoke run, not a controlled before/after performance claim. Adapter
call counts and summed I/O elapsed times include waiting/coalesced requests;
they must not be interpreted as physical file writes or summed wall time.
No external Persistence adapter or multi-worker workload was benchmarked.
