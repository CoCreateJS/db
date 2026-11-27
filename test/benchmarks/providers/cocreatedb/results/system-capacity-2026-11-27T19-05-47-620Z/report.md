# CoCreateDB system capacity benchmark

- Fixture: system-workload-1.0.0
- Records: 1,000,000 across 1 organization(s), 80 arrays, 8 workers
- Create acknowledgement: 8315.2 records/s; 10983.75 ms p95 request latency
- Index drain after acknowledgements: 3.0 ms
- UUID read: 4607.2 ops/s; p95 8.26 ms
- Indexed rank read: 3585.3 ops/s; p95 10.30 ms
- Update: 3398.9 ops/s; p95 13.02 ms
- Delete: 1371.1 ops/s; p95 24.00 ms
- Mixed CRUD: 124.6 ops/s (counts: {"create":320,"read":320,"update":320,"delete":320})
- Overall acknowledged throughput: 290.6 requests/s
- Host average busy CPU: 84.8% across logical CPUs
- Host average memory used: 35.7%
- Pending at endpoint: 0 index entries, 1365640 disk queue entries
- Disk drain: intentionally not awaited; see raw JSON for per-phase adapter operation counts, bytes and rates.

- Persistence: test stub only; external calls and durable acknowledgement are not measured. Internal queue lock wait is not exposed by the current runtime.
This result uses the versioned system fixture and is not directly comparable to the standard v3 provider benchmark.
