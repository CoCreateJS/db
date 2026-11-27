# CoCreateDB system capacity benchmark

- Fixture: system-workload-1.0.0
- Records: 1,500,000 across 1 organization(s), 80 arrays, 8 workers
- Create acknowledgement: 7246.3 records/s; 13982.05 ms p95 request latency
- Index drain after acknowledgements: 1.8 ms
- UUID read: 4818.4 ops/s; p95 7.47 ms
- Indexed rank read: 2994.7 ops/s; p95 12.96 ms
- Update: 3102.4 ops/s; p95 13.78 ms
- Delete: 1297.6 ops/s; p95 26.01 ms
- Mixed CRUD: 60.9 ops/s (counts: {"create":166,"read":166,"update":166,"delete":166})
- Overall acknowledged throughput: 180.3 requests/s
- Host average busy CPU: 84.4% across logical CPUs
- Host average memory used: 46.1%
- Pending at endpoint: 0 index entries, 1998477 disk queue entries
- Disk drain: intentionally not awaited; see raw JSON for per-phase adapter operation counts, bytes and rates.

- Persistence: test stub only; external calls and durable acknowledgement are not measured. Internal queue lock wait is not exposed by the current runtime.
This result uses the versioned system fixture and is not directly comparable to the standard v3 provider benchmark.
