# Index-ready lifecycle: one organization, 400,000 records

Status: index-ready. Configuration: 80 primary arrays × 5,000 records = 400,000 records. The measured lifecycle ends when all records are acknowledged and the index queue is empty. Disk drain was not awaited.

## Acknowledgement and indexing

- Acknowledged: 400,000 records in 88135.86 ms (4538 records/s; 9.1 requests/s).
- Index-ready lifecycle: 93016.85 ms (4300 records/s); pending index items at end: 0.
- Mean create request acknowledgement time was 8122.55 ms across 800 concurrent requests (500 records/request); request-latency percentiles were not retained by this run. Read, update, and delete were not run.
- Overall create-plus-index throughput was 8.6 requests/s and 4300 records/s.
- The index queue cleared 4880.99 ms after the last acknowledgement returned; indexing and acknowledgement overlap, so the lifecycle wall time is the combined end-to-end measure.
- Acknowledgement call time summed across requests: 6498040.76 ms across 800 calls. This sum can exceed wall time because requests overlap.

## Host CPU

- CPU: AMD EPYC 7571; 4 cores × 2 threads (8 logical CPUs), x86_64 on KVM. OS did not report a usable CPU frequency.
- Average host busy CPU during the measured lifecycle: 18.80%; host iowait: 0.01%.

## Disk queue and file operations at index readiness

- Disk queue items outstanding: 600560; adapter operations started/completed/failed: 35/18/0.
- Adapter operations still in flight: 17; estimated outstanding operations: 17; bytes submitted to writes: 19,160.
- Average adapter operation rates during lifecycle: 0.4 started/s, 0.2 completed/s. These include adapter writes/deletes; persistence notification calls are separate and are not counted as file operations.
- Queue item count and adapter operation count are different units: pendingDiskItems counts queued Tree storage records, while adapter operations count calls into the disk adapter.
- Operations by kind/action: {"file.write":35}. Per-second queue and I/O samples are in result.json.

Peak process RSS: 4252.1 MiB. Host memory: 31.1 GiB. Fixture SHA-256: 88c408c2e41490337217fd785c035b73e55b14166d9feeefa7cc3ef9775df1c7.

This is one local single-process run. Index throughput counts acknowledged records when the index queue reaches zero; it does not claim completed disk persistence.
