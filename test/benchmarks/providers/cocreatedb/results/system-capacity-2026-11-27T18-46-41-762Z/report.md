# CoCreateDB system capacity benchmark

- Fixture: system-workload-1.0.0
- Records: 2,000,000 across 1 organization(s), 80 arrays, 8 workers (25,000 per array)
- Create acknowledgement: 6772.9 records/s; 15229.05 ms p95 request latency
- Index drain after acknowledgements: 8.1 ms
- UUID read: 2671.7 ops/s; p95 19.68 ms
- Indexed rank read: 2178.7 ops/s; p95 18.12 ms
- Update: 2715.3 ops/s; p95 14.51 ms
- Delete: 192.4 ops/s; p95 265.09 ms
- Mixed CRUD: 34.4 ops/s (counts: {"create":86,"read":86,"update":86,"delete":86})
- Overall acknowledged throughput: 114.4 requests/s; 5503.2 record operations/s
- Host average busy CPU: 79.7% across logical CPUs
- Host average memory used: 58.4%; peak 77.1%
- Pending at endpoint: 0 index entries, 2797712 disk queue entries
- Disk drain: intentionally not awaited; see raw JSON for per-phase adapter operations, bytes and rates.
- Persistence: test stub only; external calls and durable acknowledgement are not measured. Internal queue lock wait is not exposed by the current runtime.
- Benchmark result status: passed. Runner cleanup was interrupted after the result JSON was saved because worker shutdown did not finish promptly.
This result uses the versioned system fixture and is not directly comparable to the standard v3 provider benchmark.
