# Primary-orchestrated worker Trees: 10K comparison

Current uncommitted dev worktree, based on checkpoint 38ff8e4. Node v24.18.0.
One organization, four primary tables, 10,000 total records (2,500 per table),
1,000-record request chunks after one routing seed per table, four concurrent
producer loops. Local Disk is shared by namespace; each Tree has one writing
owner. The primary uses existing CoCreate IPC to dispatch to real Node workers.
Producer/client loops run in the primary; timings include IPC dispatch/reply,
not HTTP/socket transport or the additional worker-ingress hop.
Workers are ready before DB requests. Production startup ordering is unchanged.

Fixture: lifecycle v3 with an added table field. Matching SHA-256:
d3600863d7a652787bb475f4ee87227555f6f7a94fec9a5215d59e238628281b

| Measurement | One execution worker | Two execution workers |
| --- | ---: | ---: |
| Process count, including primary | 2 | 3 |
| Create acknowledgement wall time, including routing seeds | 1.759 s | 1.856 s |
| Create and index wall time | 6.087 s | 6.229 s |
| Primary-local Trees | 0 | 0 |
| Final pending index records | 0 | 0 |
| Primary RSS after initial indexing | 112.0 MiB | 108.0 MiB |
| Sum of worker RSS samples after initial indexing | 246.8 MiB | 308.2 MiB |

These are single samples per configuration, not peak memory measurements.
Two workers took 2.3% longer for this workload;
this does not demonstrate a scaling improvement. The earlier development runs
were also close (5.82 seconds with one worker, 6.12 seconds with two). More CPU
parallelism is available across Trees, but throughput still needs profiling.
Comparisons here apply to this four-table workload, with IPC and local writes.

## Verified behavior

- Round-robin ownership is assigned once and reused for subsequent requests.
- The primary creates no local Tree; workers own leaves, indexes and queues.
- Worker ingress can route through the primary and back to its owning worker.
- UUID lookup, query ordering/pagination and cross-table merging remain correct.
- Update/delete indexes and organization isolation pass assertions.
- Pruning chooses each worker's own lowest-weight eligible Tree.
- Pruning retains placement, and subsequent reads hydrate only their page.
- Queued/in-flight storage prevents eviction; the 50% signal stops pruning.
- No leaf-only cleanup or global weight-reporting process was added.

Full test suite: 68 passed, including real CoCreate IPC integration. The benchmark
uses synthetic 75%/50% controls to verify the policy; it is not a real memory
exhaustion test. Worker exit/reassignment and production cluster startup remain
outside this implementation.

Run again:

`node test/benchmarks/diagnostics/workers.mjs 10000`

Raw reports: [one worker](1-workers.json), [two workers](2-workers.json),
[combined comparison](comparison.json).
