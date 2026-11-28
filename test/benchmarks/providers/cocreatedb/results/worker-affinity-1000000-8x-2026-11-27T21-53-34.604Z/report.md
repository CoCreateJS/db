# Worker organization affinity benchmark

Status: passed. Total records: 1,000,000; workers and organizations: 8; disk mode: local. The benchmark driver has no DB. Each worker process initializes a local DB instance and owns exactly one organization. Work is pinned to that worker for the entire run.

## Assignment

| Worker | Organization | Records | PID |
| --- | --- | ---: | ---: |
| 1 | 000000000000000000000001 | 125,000 | 105664 |
| 2 | 000000000000000000000002 | 125,000 | 105665 |
| 3 | 000000000000000000000003 | 125,000 | 105666 |
| 4 | 000000000000000000000004 | 125,000 | 105672 |
| 5 | 000000000000000000000005 | 125,000 | 105678 |
| 6 | 000000000000000000000006 | 125,000 | 105684 |
| 7 | 000000000000000000000007 | 125,000 | 105690 |
| 8 | 000000000000000000000008 | 125,000 | 105696 |

## Throughput and acknowledgements

CRUD request loops run sequentially within each worker and concurrently across workers. Throughput uses host-side IPC acknowledgement wall time. Mutation index drain is reported separately.

| Operation | Requests | Records / operations | Ack wall (ms) | Requests/s | Records / operations/s | Avg ack (ms) | P95 ack (ms) | Index drain (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| bulkCreate | 1000 | 1000000 | 60168.48 | 16.6 | 16620.0 | 452.261 | 607.939 | 18.81 |
| create | 80000 | 80000 | 242017.14 | 330.6 | 330.6 | 22.584 | 38.232 | 1.05 |
| readByUuid | 80000 | 80000 | 8098.56 | 9878.3 | 9878.3 | 0.785 | 1.218 | 0.00 |
| indexedRead | 80000 | 80000 | 14706.77 | 5439.7 | 5439.7 | 1.455 | 3.609 | 0.00 |
| update | 80000 | 80000 | 19277.37 | 4149.9 | 4149.9 | 1.908 | 4.485 | 1.09 |
| delete | 80000 | 80000 | 90508.58 | 883.9 | 883.9 | 8.920 | 17.805 | 1.46 |
| overall | 401000 | 1400000 | 434776.88 | 922.3 | 3220.0 | - | - | 22.41 |

Bulk create and indexing wall time: 60.23 s. Bulk create acknowledgement-to-index tail: 0.02 s. Pending index items at index-ready: 0. Pending disk items at index-ready: 1520878. Index readiness waits only for the index queue; disk backlog remains an independent measurement.

Host CPU average across 8 available logical CPUs: 76.68%. Host memory average used: 67.84%; peak sampled used: 79.29%. Observed aggregate worker RSS peak: 22003.6 MiB. Sum of per-worker peak RSS values: 22028.6 MiB; individual peaks may not be simultaneous.

Disk queue and adapter at index-ready: {"started":1077368,"completed":1077200,"failed":40,"inFlight":128,"bytesWritten":44197476,"outstanding":128,"byKindAction":{"file.read":40,"file.write":77328,"file.has":1000000},"failures":{"file.read:ENOENT":40}}. Disk queue and adapter at workload end: {"started":2340417,"completed":2340249,"failed":40,"inFlight":128,"bytesWritten":944354847,"outstanding":128,"byKindAction":{"file.read":40,"file.write":1260377,"file.has":1080000},"failures":{"file.read:ENOENT":40}}. Disk mode note: real local disk adapter attached. Correctness: {"oneOrganizationPerWorker":true,"allWorkersUsed":true,"distinctWorkerProcesses":true,"allRecordsAcknowledged":true,"indexReadyOnAllWorkers":true,"crudSamplesPassed":true}.
