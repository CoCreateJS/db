# Parallel organization benchmark

Status: passed. One process, 4 concurrent organization Trees, 100,000 records each.

| Organization | Acknowledged at (s) | Remaining index drain (s) | Create + index (s) |
| --- | ---: | ---: | ---: |
| 000000000000000000000001 | 35.16 | 249.87 | 285.03 |
| 000000000000000000000002 | 35.20 | 249.62 | 284.83 |
| 000000000000000000000003 | 35.25 | 249.77 | 285.01 |
| 000000000000000000000004 | 35.29 | 249.43 | 284.72 |

Combined create/index wall time: 285.03 s. Throughput: 1403 records/s. Peak process RSS: 2955.9 MiB.

Per-organization timings overlap and must not be summed. Telemetry, disk writes and indexing share the process. This diagnostic does not include the standard sustained workloads. Correctness checks: {"uuidReads":"passed","indexedReads":"passed","separateDirectories":"passed","updateAndDeleteIsolation":"passed"}.
