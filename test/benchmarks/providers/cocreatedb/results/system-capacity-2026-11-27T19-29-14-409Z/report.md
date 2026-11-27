# CoCreateDB system capacity benchmark

- Fixture: system-workload-1.0.0
- Records: 700,000 across 1 organization(s), 80 arrays, 8 workers
- Create acknowledgement: 9065.3 records/s; 9797.34 ms p95 request latency
- Index drain after acknowledgements: 2.1 ms
- UUID read: 3123.6 ops/s; p95 15.28 ms
- Indexed rank read: 3082.9 ops/s; p95 12.96 ms
- Update: 2718.7 ops/s; p95 15.24 ms
- Delete: 1331.8 ops/s; p95 26.77 ms
- Mixed CRUD: 105.6 ops/s (counts: {"create":274,"read":274,"update":274,"delete":274})
- Overall acknowledged throughput: 397.4 requests/s
- Host average busy CPU: 85.9% across logical CPUs
- Host average memory used: 29.8%
- Pending at endpoint: 0 index entries, 919108 disk queue entries
- Disk drain: intentionally not awaited; see raw JSON for per-phase adapter operation counts, bytes and rates.

- Persistence: test stub only; external calls and durable acknowledgement are not measured. Internal queue lock wait is not exposed by the current runtime.
This result uses the versioned system fixture and is not directly comparable to the standard v3 provider benchmark.
