# Worker organization affinity benchmark

Status: passed. Total records: 2,000,000; workers and organizations: 8; disk mode: local. The benchmark driver has no DB. Each worker process initializes a local DB instance and owns exactly one organization. Work is pinned to that worker for the entire run.

## Assignment

| Worker | Organization | Records | PID |
| --- | --- | ---: | ---: |
| 1 | 000000000000000000000001 | 250,000 | 122198 |
| 2 | 000000000000000000000002 | 250,000 | 122199 |
| 3 | 000000000000000000000003 | 250,000 | 122200 |
| 4 | 000000000000000000000004 | 250,000 | 122206 |
| 5 | 000000000000000000000005 | 250,000 | 122207 |
| 6 | 000000000000000000000006 | 250,000 | 122218 |
| 7 | 000000000000000000000007 | 250,000 | 122224 |
| 8 | 000000000000000000000008 | 250,000 | 122230 |

## Throughput and acknowledgements

CRUD request loops run sequentially within each worker and concurrently across workers. Throughput uses host-side IPC acknowledgement wall time. Mutation index drain is reported separately.

| Operation | Requests | Records / operations | Ack wall (ms) | Requests/s | Records / operations/s | Avg ack (ms) | P95 ack (ms) | Index drain (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| bulkCreate | 2000 | 2000000 | 139089.11 | 14.4 | 14379.3 | 530.971 | 741.390 | 7.16 |
| create | 80000 | 80000 | 536919.88 | 149.0 | 149.0 | 42.071 | 87.017 | 107.65 |
| readByUuid | 80000 | 80000 | 13369.66 | 5983.7 | 5983.7 | 1.261 | 3.114 | 0.00 |
| indexedRead | 80000 | 80000 | 31189.65 | 2565.0 | 2565.0 | 3.074 | 9.152 | 0.00 |
| update | 80000 | 80000 | 40473.54 | 1976.6 | 1976.6 | 3.963 | 9.519 | 14.08 |
| delete | 80000 | 80000 | 137987.97 | 579.8 | 579.8 | 13.584 | 28.984 | 0.74 |
| overall | 402000 | 2400000 | 899029.81 | 447.1 | 2669.5 | - | - | 129.64 |

Bulk create and indexing wall time: 139.11 s. Bulk create acknowledgement-to-index tail: 0.01 s. Pending index items at index-ready: 0. Pending disk items at index-ready: 2934307. Index readiness waits only for the index queue; disk backlog remains an independent measurement.

Host CPU average across 8 available logical CPUs: 67.07%. Host memory average used: 81.13%; peak sampled used: 93.99%. Observed aggregate worker RSS peak: 26939.4 MiB. Sum of per-worker peak RSS values: 27243.0 MiB; individual peaks may not be simultaneous.

Disk queue and adapter at index-ready: {"started":5748976,"completed":2814629,"failed":40,"inFlight":2934307,"bytesWritten":6804663880,"outstanding":2934307,"byKindAction":{"roots.read":8,"roots.write":32,"config.read":32,"leaf.write":2000024,"branch.write":1746856,"config.write":2024,"leaf.has":2000000},"failures":{"roots.read:ENOENT":8,"config.read:ENOENT":32}}. Disk queue and adapter at workload end: {"started":17633992,"completed":15972804,"failed":40,"inFlight":1661148,"bytesWritten":65346628568,"outstanding":1661148,"byKindAction":{"roots.read":8,"roots.write":32,"config.read":32,"leaf.write":2160024,"branch.write":13109728,"config.write":162032,"leaf.has":2080000,"branch.delete":42136,"leaf.delete":80000},"failures":{"roots.read:ENOENT":8,"config.read:ENOENT":32}}. Disk mode note: real local disk adapter attached. Correctness: {"oneOrganizationPerWorker":true,"allWorkersUsed":true,"distinctWorkerProcesses":true,"allRecordsAcknowledged":true,"indexReadyOnAllWorkers":true,"crudSamplesPassed":true}.
