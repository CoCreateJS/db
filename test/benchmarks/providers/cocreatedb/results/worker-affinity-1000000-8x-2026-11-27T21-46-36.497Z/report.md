# Worker organization affinity benchmark

Status: passed. Total records: 1,000,000; workers and organizations: 8; disk mode: disabled. The benchmark driver has no DB. Each worker process initializes a local DB instance and owns exactly one organization. Work is pinned to that worker for the entire run.

## Assignment

| Worker | Organization | Records | PID |
| --- | --- | ---: | ---: |
| 1 | 000000000000000000000001 | 125,000 | 103898 |
| 2 | 000000000000000000000002 | 125,000 | 103899 |
| 3 | 000000000000000000000003 | 125,000 | 103900 |
| 4 | 000000000000000000000004 | 125,000 | 103906 |
| 5 | 000000000000000000000005 | 125,000 | 103907 |
| 6 | 000000000000000000000006 | 125,000 | 103918 |
| 7 | 000000000000000000000007 | 125,000 | 103924 |
| 8 | 000000000000000000000008 | 125,000 | 103930 |

## Throughput and acknowledgements

CRUD request loops run sequentially within each worker and concurrently across workers. Throughput uses host-side IPC acknowledgement wall time. Mutation index drain is reported separately.

| Operation | Requests | Records / operations | Ack wall (ms) | Requests/s | Records / operations/s | Avg ack (ms) | P95 ack (ms) | Index drain (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| bulkCreate | 1000 | 1000000 | 37333.09 | 26.8 | 26785.9 | 277.827 | 384.003 | 3.52 |
| create | 80000 | 80000 | 14497.59 | 5518.2 | 5518.2 | 1.427 | 3.046 | 1.20 |
| readByUuid | 80000 | 80000 | 6903.77 | 11587.9 | 11587.9 | 0.670 | 0.997 | 0.00 |
| indexedRead | 80000 | 80000 | 10103.43 | 7918.1 | 7918.1 | 0.993 | 1.859 | 0.00 |
| update | 80000 | 80000 | 10041.13 | 7967.2 | 7967.2 | 0.982 | 2.765 | 0.82 |
| delete | 80000 | 80000 | 15241.46 | 5248.8 | 5248.8 | 1.504 | 3.456 | 0.71 |
| overall | 401000 | 1400000 | 94120.47 | 4260.5 | 14874.6 | - | - | 6.25 |

Bulk create and indexing wall time: 37.34 s. Bulk create acknowledgement-to-index tail: 0.00 s. Pending index items at index-ready: 0. Pending disk items at index-ready: 0.

Host CPU average across 8 available logical CPUs: 86.64%. Observed aggregate worker RSS peak: 8111.6 MiB. Sum of per-worker peak RSS values: 8146.0 MiB; individual peaks may not be simultaneous.

Disk note: disk adapter is not attached. Correctness: {"oneOrganizationPerWorker":true,"allWorkersUsed":true,"distinctWorkerProcesses":true,"allRecordsAcknowledged":true,"indexReadyOnAllWorkers":true,"crudSamplesPassed":true}.
