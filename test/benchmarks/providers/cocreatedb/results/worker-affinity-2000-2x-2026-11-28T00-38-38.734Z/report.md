# Worker organization affinity benchmark

Status: passed. Total records: 2,000; workers and organizations: 2; disk mode: local. The benchmark driver has no DB. Each worker process initializes a local DB instance and owns exactly one organization. Work is pinned to that worker for the entire run.

## Assignment

| Worker | Organization | Records | PID |
| --- | --- | ---: | ---: |
| 1 | 000000000000000000000001 | 1,000 | 142887 |
| 2 | 000000000000000000000002 | 1,000 | 142888 |

## Throughput and acknowledgements

CRUD request loops run sequentially within each worker and concurrently across workers. Throughput uses host-side IPC acknowledgement wall time. Mutation index drain is reported separately.

| Operation | Requests | Records / operations | Ack wall (ms) | Requests/s | Records / operations/s | Avg ack (ms) | P95 ack (ms) | In-memory index catch-up (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| bulkCreate | 2 | 2000 | 501.89 | 4.0 | 3985.0 | 237.758 | 242.626 | 4.69 |
| create | 40 | 40 | 99.65 | 401.4 | 401.4 | 4.921 | 7.168 | 1.56 |
| readByUuid | 40 | 40 | 33.40 | 1197.7 | 1197.7 | 1.638 | 2.804 | 0.00 |
| indexedRead | 40 | 40 | 53.78 | 743.8 | 743.8 | 2.569 | 5.831 | 0.00 |
| update | 40 | 40 | 47.64 | 839.6 | 839.6 | 2.363 | 4.906 | 1.74 |
| delete | 40 | 40 | 69.27 | 577.5 | 577.5 | 3.385 | 5.194 | 1.25 |
| overall | 202 | 2200 | 805.63 | 250.7 | 2730.8 | - | - | 9.24 |

Bulk create → in-memory indexes ready: 0.51 s. In-memory index catch-up after bulk acknowledgement: 0.00 s. Pending index items at index-ready: 0. Outstanding storage requests at index-ready (not unique files): 2962. Index readiness waits only for the index queue; disk backlog remains an independent measurement.

Host CPU average across 8 available logical CPUs: 60.42%. Host memory average used: 7.76%; peak sampled used: 7.76%. Observed aggregate worker RSS peak: 229.1 MiB. Sum of per-worker peak RSS values: 229.7 MiB; individual peaks may not be simultaneous.

Disk mode note: real local disk adapter attached. Correctness: {"oneOrganizationPerWorker":true,"allWorkersUsed":true,"distinctWorkerProcesses":true,"allRecordsAcknowledged":true,"indexReadyOnAllWorkers":true,"crudSamplesPassed":true}.

## Storage accounting at in-memory index readiness

### Requests submitted to Disk, before coalescing

| Resource | Write requests submitted | Replaced while pending | Cancelled while pending | Write requests outstanding | Submitted payload (MiB) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Leaf document files | 2,006 | 0 | 0 | 1,964 | 0.96 |
| Index branch files | 1,012 | 0 | 0 | 996 | 1.76 |
| Configuration files (roots + catalogs) | 16 | 4 | 0 | 2 | 0.01 |

### Filesystem writes after coalescing

| Resource | File writes started | File writes completed | Files published by rename | Completed file payload (MiB) |
| --- | ---: | ---: | ---: | ---: |
| Leaf document files | 68 | 49 | 42 | 0.02 |
| Index branch files | 16 | 16 | 16 | 0.00 |
| Configuration files (roots + catalogs) | 10 | 10 | 10 | 0.00 |

These are filesystem API completions, not block-device/EBS IOPS or fsync durability.
Outstanding work is not counted as eliminated work. Replaced/cancelled counts come
from explicit adapter responses. In-memory branch mutation counts are not measured;
in-memory index readiness is reported separately from these storage tables.

## Storage accounting at workload end

### Requests submitted to Disk, before coalescing

| Resource | Write requests submitted | Replaced while pending | Cancelled while pending | Write requests outstanding | Submitted payload (MiB) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Leaf document files | 2,086 | 80 | 0 | 618 | 1.00 |
| Index branch files | 3,812 | 2,800 | 0 | 996 | 12.95 |
| Configuration files (roots + catalogs) | 98 | 86 | 0 | 2 | 0.21 |

### Filesystem writes after coalescing

| Resource | File writes started | File writes completed | Files published by rename | Completed file payload (MiB) |
| --- | ---: | ---: | ---: | ---: |
| Leaf document files | 1,413 | 1,401 | 1,388 | 0.67 |
| Index branch files | 16 | 16 | 16 | 0.00 |
| Configuration files (roots + catalogs) | 10 | 10 | 10 | 0.00 |

These are filesystem API completions, not block-device/EBS IOPS or fsync durability.
Outstanding work is not counted as eliminated work. Replaced/cancelled counts come
from explicit adapter responses. In-memory branch mutation counts are not measured;
in-memory index readiness is reported separately from these storage tables.
