# CoCreateDB system capacity benchmark

- Fixture: system-workload-1.0.0
- Records: 400,000 across 1 organization(s), 80 arrays, 8 workers
- Create acknowledgement: 9367.0 records/s; 9049.85 ms p95 request latency
- Index drain after acknowledgements: 8.8 ms
- UUID read: 2574.4 ops/s; p95 17.30 ms
- Indexed rank read: 2539.1 ops/s; p95 16.25 ms
- Update: 2665.0 ops/s; p95 15.49 ms
- Delete: 1345.8 ops/s; p95 26.01 ms
- Mixed CRUD: 304.0 ops/s (counts: {"create":762,"read":762,"update":762,"delete":762})
- Overall acknowledged throughput: 604.4 requests/s
- Host average busy CPU: 85.2% across logical CPUs
- Host average memory used: 27.5%
- Pending at endpoint: 0 index entries, 583064 disk queue entries
- Disk drain: intentionally not awaited; see raw JSON for per-phase adapter operation counts, bytes and rates.

- Persistence: test stub only; external calls and durable acknowledgement are not measured. Internal queue lock wait is not exposed by the current runtime.
This result uses the versioned system fixture and is not directly comparable to the standard v3 provider benchmark.
