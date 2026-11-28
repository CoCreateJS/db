# Worker organization affinity benchmark

Status: passed. Total records: 400,000; workers and organizations: 8; disk mode: local. The benchmark driver has no DB. Each worker process initializes a local DB instance and owns exactly one organization. Work is pinned to that worker for the entire run.

## Assignment

| Worker | Organization | Records | PID |
| --- | --- | ---: | ---: |
| 1 | 000000000000000000000001 | 50,000 | 130893 |
| 2 | 000000000000000000000002 | 50,000 | 130894 |
| 3 | 000000000000000000000003 | 50,000 | 130895 |
| 4 | 000000000000000000000004 | 50,000 | 130901 |
| 5 | 000000000000000000000005 | 50,000 | 130903 |
| 6 | 000000000000000000000006 | 50,000 | 130908 |
| 7 | 000000000000000000000007 | 50,000 | 130914 |
| 8 | 000000000000000000000008 | 50,000 | 130921 |

## Throughput and acknowledgements

CRUD request loops run sequentially within each worker and concurrently across workers. Throughput uses host-side IPC acknowledgement wall time. Mutation index drain is reported separately.

| Operation | Requests | Records / operations | Ack wall (ms) | Requests/s | Records / operations/s | Avg ack (ms) | P95 ack (ms) | Index drain (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| bulkCreate | 400 | 400000 | 26171.24 | 15.3 | 15284.0 | 488.846 | 710.757 | 10.64 |
| create | 80000 | 80000 | 188704.42 | 423.9 | 423.9 | 17.971 | 31.387 | 1.64 |
| readByUuid | 80000 | 80000 | 7366.16 | 10860.5 | 10860.5 | 0.713 | 1.102 | 0.00 |
| indexedRead | 80000 | 80000 | 24485.08 | 3267.3 | 3267.3 | 2.401 | 4.482 | 0.00 |
| update | 80000 | 80000 | 22385.04 | 3573.8 | 3573.8 | 2.218 | 5.622 | 0.94 |
| delete | 80000 | 80000 | 83138.42 | 962.3 | 962.3 | 8.150 | 16.537 | 1.08 |
| overall | 400400 | 800000 | 352250.36 | 1136.7 | 2271.1 | - | - | 14.29 |

Bulk create and indexing wall time: 26.23 s. Bulk create acknowledgement-to-index tail: 0.01 s. Pending index items at index-ready: 0. Pending disk items at index-ready: 580351. Index readiness waits only for the index queue; disk backlog remains an independent measurement.

Host CPU average across 8 available logical CPUs: 81.49%. Host memory average used: 50.46%; peak sampled used: 56.22%. Observed aggregate worker RSS peak: 15259.5 MiB. Sum of per-worker peak RSS values: 15262.0 MiB; individual peaks may not be simultaneous.

Disk queue and adapter at index-ready: {"started":1112168,"completed":531777,"failed":40,"inFlight":580351,"bytesWritten":1037660264,"outstanding":580351,"byKindAction":{"roots.read":8,"roots.write":32,"config.read":32,"leaf.write":400024,"branch.write":311648,"config.write":424,"leaf.has":400000},"failures":{"roots.read:ENOENT":8,"config.read:ENOENT":32}}. Disk queue and adapter at workload end: {"started":10197158,"completed":10197092,"failed":46,"inFlight":20,"bytesWritten":58019237672,"outstanding":20,"byKindAction":{"roots.read":8,"roots.write":32,"config.read":32,"leaf.write":560024,"branch.write":8874440,"config.write":160432,"leaf.has":480000,"branch.delete":42184,"leaf.delete":80000,"leaf.read":6},"failures":{"roots.read:ENOENT":8,"config.read:ENOENT":32,"leaf.read:ENOENT":6}}. Disk mode note: real local disk adapter attached. Correctness: {"oneOrganizationPerWorker":true,"allWorkersUsed":true,"distinctWorkerProcesses":true,"allRecordsAcknowledged":true,"indexReadyOnAllWorkers":true,"crudSamplesPassed":true}.
