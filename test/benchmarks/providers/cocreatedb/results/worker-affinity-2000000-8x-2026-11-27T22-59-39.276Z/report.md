# Worker organization affinity benchmark

Status: failed. Total records: 2,000,000; workers and organizations: 8; disk mode: local. The benchmark driver has no DB. Each worker process initializes a local DB instance and owns exactly one organization. Work is pinned to that worker for the entire run.

## Assignment

| Worker | Organization | Records | PID |
| --- | --- | ---: | ---: |
| 1 | 000000000000000000000001 | 250,000 | 121122 |
| 2 | 000000000000000000000002 | 250,000 | 121123 |
| 3 | 000000000000000000000003 | 250,000 | 121124 |
| 4 | 000000000000000000000004 | 250,000 | 121130 |
| 5 | 000000000000000000000005 | 250,000 | 121136 |
| 6 | 000000000000000000000006 | 250,000 | 121142 |
| 7 | 000000000000000000000007 | 250,000 | 121148 |
| 8 | 000000000000000000000008 | 250,000 | 121154 |

## Throughput and acknowledgements

CRUD request loops run sequentially within each worker and concurrently across workers. Throughput uses host-side IPC acknowledgement wall time. Mutation index drain is reported separately.

| Operation | Requests | Records / operations | Ack wall (ms) | Requests/s | Records / operations/s | Avg ack (ms) | P95 ack (ms) | Index drain (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |


Bulk create and indexing wall time: 0.00 s. Bulk create acknowledgement-to-index tail: 0.00 s. Pending index items at index-ready: not reached. Pending disk items at index-ready: not sampled. Index readiness waits only for the index queue; disk backlog remains an independent measurement.

Host CPU average across 8 available logical CPUs: not sampled%. Host memory average used: not sampled%; peak sampled used: not sampled%. Observed aggregate worker RSS peak: 468.3 MiB. Sum of per-worker peak RSS values: 0.0 MiB; individual peaks may not be simultaneous.

Disk queue and adapter at index-ready: null. Disk queue and adapter at workload end: null. Disk mode note: real local disk adapter attached. Correctness: {"message":"Cannot read properties of undefined (reading 'active')","stack":"Error: Cannot read properties of undefined (reading 'active')\n    at process.<anonymous> (file:///home/ubuntu/Dev/CoCreateJS/modules/db/test-support/worker-affinity-db.mjs:77:42)\n    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)","workerId":6}.
