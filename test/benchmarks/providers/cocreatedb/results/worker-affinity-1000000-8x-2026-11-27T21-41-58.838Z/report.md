# Worker organization affinity benchmark

Status: failed. Total records: 1,000,000; workers and organizations: 8; disk mode: noop. The benchmark driver has no DB. Each worker process initializes a local DB instance and owns exactly one organization. Work is pinned to that worker for the entire run.

## Assignment

| Worker | Organization | Records | PID |
| --- | --- | ---: | ---: |
| 1 | 000000000000000000000001 | 125,000 | 102747 |
| 2 | 000000000000000000000002 | 125,000 | 102748 |
| 3 | 000000000000000000000003 | 125,000 | 102749 |
| 4 | 000000000000000000000004 | 125,000 | 102755 |
| 5 | 000000000000000000000005 | 125,000 | 102761 |
| 6 | 000000000000000000000006 | 125,000 | 102762 |
| 7 | 000000000000000000000007 | 125,000 | 102768 |
| 8 | 000000000000000000000008 | 125,000 | 102774 |

## Throughput and acknowledgements

CRUD request loops run sequentially within each worker and concurrently across workers. Throughput uses host-side IPC acknowledgement wall time. Mutation index drain is reported separately.

| Operation | Requests | Records / operations | Ack wall (ms) | Requests/s | Records / operations/s | Avg ack (ms) | P95 ack (ms) | Index drain (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| bulkCreate | 1000 | 1000000 | 46537.61 | 21.5 | 21488.0 | 347.853 | 470.583 | 3.47 |
| create | 80000 | 80000 | 67989.26 | 1176.7 | 1176.7 | 6.770 | 14.734 | 1.36 |

Bulk create and indexing wall time: 46.56 s. Bulk create acknowledgement-to-index tail: 0.00 s. Pending index items at index-ready: 0. Pending disk items at index-ready: 0.

Host CPU average across 8 available logical CPUs: not sampled%. Observed aggregate worker RSS peak: 20525.9 MiB. Sum of per-worker peak RSS values: 0.0 MiB; individual peaks may not be simultaneous.

Disk note: adapter calls return immediately without physical I/O; the worker-local disk tier remains in the indexing path. Correctness: {"message":"readByUuid returns one record per request\n\n0 !== 1\n","stack":"AssertionError [ERR_ASSERTION]: readByUuid returns one record per request\n\n0 !== 1\n\n    at file:///home/ubuntu/Dev/CoCreateJS/modules/db/test/benchmarks/diagnostics/worker-affinity.mjs:305:24\n    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)\n    at async Promise.all (index 2)\n    at async runCrudPhase (file:///home/ubuntu/Dev/CoCreateJS/modules/db/test/benchmarks/diagnostics/worker-affinity.mjs:293:27)\n    at async file:///home/ubuntu/Dev/CoCreateJS/modules/db/test/benchmarks/diagnostics/worker-affinity.mjs:343:5"}.
