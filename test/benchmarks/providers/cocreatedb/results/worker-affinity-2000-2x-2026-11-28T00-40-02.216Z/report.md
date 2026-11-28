# Worker organization affinity benchmark

Status: passed. Total records: 2,000; workers and organizations: 2; disk mode: local. The benchmark driver has no DB. Each worker process initializes a local DB instance and owns exactly one organization. Work is pinned to that worker for the entire run.

## Assignment

| Worker | Organization | Records | PID |
| --- | --- | ---: | ---: |
| 1 | 000000000000000000000001 | 1,000 | 143216 |
| 2 | 000000000000000000000002 | 1,000 | 143217 |

## Throughput and acknowledgements

CRUD request loops run sequentially within each worker and concurrently across workers. Throughput uses host-side IPC acknowledgement wall time. In-memory index catch-up is reported separately. A passed status covers workload correctness; storage can still be pending in the snapshots below. Shutdown drains remaining requests outside these workload timings.

| Operation | Requests | Records / operations | Ack wall (ms) | Requests/s | Records / operations/s | Avg ack (ms) | P95 ack (ms) | In-memory index catch-up (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| bulkCreate | 2 | 2000 | 509.18 | 3.9 | 3927.9 | 263.793 | 270.326 | 5.25 |
| create | 40 | 40 | 114.76 | 348.6 | 348.6 | 5.654 | 11.054 | 2.40 |
| readByUuid | 40 | 40 | 47.99 | 833.5 | 833.5 | 2.332 | 4.444 | 0.00 |
| indexedRead | 40 | 40 | 56.59 | 706.9 | 706.9 | 2.802 | 6.432 | 0.00 |
| update | 40 | 40 | 45.12 | 886.4 | 886.4 | 2.121 | 4.174 | 1.57 |
| delete | 40 | 40 | 70.40 | 568.2 | 568.2 | 3.361 | 4.399 | 1.81 |
| overall | 202 | 2200 | 844.04 | 239.3 | 2606.5 | - | - | 11.02 |

Bulk create → in-memory indexes ready: 0.52 s. In-memory index catch-up after bulk acknowledgement: 0.01 s. Pending index items at index-ready: 0. Outstanding storage requests at index-ready (not unique files): 2966. Index readiness waits only for the index queue; disk backlog remains an independent measurement.

Host CPU average across 8 available logical CPUs: 47.61%. Host memory average used: 7.29%; peak sampled used: 7.29%. Observed aggregate worker RSS peak: 228.7 MiB. Sum of per-worker peak RSS values: 228.8 MiB; individual peaks may not be simultaneous.

Disk mode note: real local disk adapter attached. Correctness: {"oneOrganizationPerWorker":true,"allWorkersUsed":true,"distinctWorkerProcesses":true,"allRecordsAcknowledged":true,"indexReadyOnAllWorkers":true,"crudSamplesPassed":true}.

## Storage accounting at in-memory index readiness

### Requests submitted to Disk, before coalescing

| Resource | Write requests submitted | Replaced while pending | Cancelled while pending | Write requests outstanding | Submitted payload (MiB) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Leaf document files | 2,006 | 0 | 0 | 1,968 | 0.96 |
| Index branch files | 1,012 | 0 | 0 | 996 | 1.76 |
| Configuration files (roots + catalogs) | 16 | 4 | 0 | 2 | 0.01 |

### Filesystem writes after coalescing

| Resource | File writes started | File writes completed | Files published by rename | Completed file payload (MiB) |
| --- | ---: | ---: | ---: | ---: |
| Leaf document files | 63 | 47 | 38 | 0.02 |
| Index branch files | 16 | 16 | 16 | 0.00 |
| Configuration files (roots + catalogs) | 10 | 10 | 10 | 0.00 |

These are filesystem API completions, not block-device/EBS IOPS or fsync durability.
Outstanding work is not counted as eliminated work. Replaced/cancelled counts come
from explicit adapter responses. In-memory branch mutation counts are not measured;
in-memory index readiness is reported separately from these storage tables.

## Storage accounting at workload end (before shutdown drain)

### Requests submitted to Disk, before coalescing

| Resource | Write requests submitted | Replaced while pending | Cancelled while pending | Write requests outstanding | Submitted payload (MiB) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Leaf document files | 2,086 | 80 | 0 | 586 | 1.00 |
| Index branch files | 3,812 | 2,800 | 0 | 996 | 12.95 |
| Configuration files (roots + catalogs) | 98 | 86 | 0 | 2 | 0.21 |

### Filesystem writes after coalescing

| Resource | File writes started | File writes completed | Files published by rename | Completed file payload (MiB) |
| --- | ---: | ---: | ---: | ---: |
| Leaf document files | 1,445 | 1,427 | 1,420 | 0.68 |
| Index branch files | 16 | 16 | 16 | 0.00 |
| Configuration files (roots + catalogs) | 10 | 10 | 10 | 0.00 |

These are filesystem API completions, not block-device/EBS IOPS or fsync durability.
Outstanding work is not counted as eliminated work. Replaced/cancelled counts come
from explicit adapter responses. In-memory branch mutation counts are not measured;
in-memory index readiness is reported separately from these storage tables.
