# Worker organization affinity benchmark

Status: passed. Total records: 400,000; workers and organizations: 8; disk mode: local. The benchmark driver has no DB. Each worker process initializes a local DB instance and owns exactly one organization. Work is pinned to that worker for the entire run.

## Assignment

| Worker | Organization | Records | PID |
| --- | --- | ---: | ---: |
| 1 | 000000000000000000000001 | 50,000 | 144662 |
| 2 | 000000000000000000000002 | 50,000 | 144663 |
| 3 | 000000000000000000000003 | 50,000 | 144667 |
| 4 | 000000000000000000000004 | 50,000 | 144670 |
| 5 | 000000000000000000000005 | 50,000 | 144676 |
| 6 | 000000000000000000000006 | 50,000 | 144682 |
| 7 | 000000000000000000000007 | 50,000 | 144688 |
| 8 | 000000000000000000000008 | 50,000 | 144689 |

## Throughput and acknowledgements

CRUD request loops run sequentially within each worker and concurrently across workers. Throughput uses host-side IPC acknowledgement wall time. In-memory index catch-up is reported separately. A passed status covers workload correctness; storage can still be pending in the snapshots below. Shutdown drains remaining requests outside these workload timings.

| Operation | Requests | Records / operations | Ack wall (ms) | Requests/s | Records / operations/s | Avg ack (ms) | P95 ack (ms) | In-memory index catch-up (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| bulkCreate | 400 | 400000 | 25273.58 | 15.8 | 15826.8 | 473.319 | 647.115 | 9.48 |
| create | 80000 | 80000 | 181817.08 | 440.0 | 440.0 | 17.577 | 28.774 | 1.22 |
| readByUuid | 80000 | 80000 | 8273.90 | 9669.0 | 9669.0 | 0.794 | 1.463 | 0.00 |
| indexedRead | 80000 | 80000 | 28311.51 | 2825.7 | 2825.7 | 2.722 | 5.169 | 0.00 |
| update | 80000 | 80000 | 24145.84 | 3313.2 | 3313.2 | 2.389 | 5.998 | 1.50 |
| delete | 80000 | 80000 | 86285.82 | 927.2 | 927.2 | 8.389 | 16.950 | 2.38 |
| overall | 400400 | 800000 | 354107.73 | 1130.7 | 2259.2 | - | - | 14.58 |

Bulk create → in-memory indexes ready: 25.29 s. In-memory index catch-up after bulk acknowledgement: 0.01 s. Pending index items at index-ready: 0. Outstanding storage requests at index-ready (not unique files): 582277. Index readiness waits only for the index queue; disk backlog remains an independent measurement.

Host CPU average across 8 available logical CPUs: 81.33%. Host memory average used: 51.22%; peak sampled used: 56.85%. Observed aggregate worker RSS peak: 15358.3 MiB. Sum of per-worker peak RSS values: 15371.7 MiB; individual peaks may not be simultaneous.

Disk mode note: real local disk adapter attached. Correctness: {"oneOrganizationPerWorker":true,"allWorkersUsed":true,"distinctWorkerProcesses":true,"allRecordsAcknowledged":true,"indexReadyOnAllWorkers":true,"crudSamplesPassed":true}.

## Storage accounting at in-memory index readiness

### Requests submitted to Disk, before coalescing

| Resource | Write requests submitted | Replaced while pending | Cancelled while pending | Write requests outstanding | Submitted payload (MiB) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Leaf document files | 400,024 | 0 | 0 | 378,892 | 192.01 |
| Index branch files | 311,648 | 99,919 | 0 | 203,377 | 796.59 |
| Configuration files (roots + catalogs) | 456 | 400 | 0 | 8 | 0.98 |

### Filesystem writes after coalescing

| Resource | File writes started | File writes completed | Files published by rename | Completed file payload (MiB) |
| --- | ---: | ---: | ---: | ---: |
| Leaf document files | 21,217 | 21,157 | 21,132 | 10.12 |
| Index branch files | 8,376 | 8,366 | 8,352 | 13.92 |
| Configuration files (roots + catalogs) | 48 | 48 | 48 | 0.04 |

These are filesystem API completions, not block-device/EBS IOPS or fsync durability.
Outstanding work is not counted as eliminated work. Replaced/cancelled counts come
from explicit adapter responses. In-memory branch mutation counts are not measured;
in-memory index readiness is reported separately from these storage tables.

## Storage accounting at workload end (before shutdown drain)

### Requests submitted to Disk, before coalescing

| Resource | Write requests submitted | Replaced while pending | Cancelled while pending | Write requests outstanding | Submitted payload (MiB) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Leaf document files | 560,024 | 0 | 0 | 0 | 269.46 |
| Index branch files | 8,874,440 | 8,581,664 | 0 | 0 | 54674.94 |
| Configuration files (roots + catalogs) | 160,464 | 160,237 | 0 | 0 | 387.05 |

### Filesystem writes after coalescing

| Resource | File writes started | File writes completed | Files published by rename | Completed file payload (MiB) |
| --- | ---: | ---: | ---: | ---: |
| Leaf document files | 560,024 | 560,024 | 560,024 | 269.46 |
| Index branch files | 292,776 | 292,776 | 292,776 | 582.09 |
| Configuration files (roots + catalogs) | 227 | 227 | 227 | 0.47 |

These are filesystem API completions, not block-device/EBS IOPS or fsync durability.
Outstanding work is not counted as eliminated work. Replaced/cancelled counts come
from explicit adapter responses. In-memory branch mutation counts are not measured;
in-memory index readiness is reported separately from these storage tables.
