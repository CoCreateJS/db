# Parallel organization benchmark

Status: passed. One process, 4 concurrent organization Trees, 100,000 records each.

| Organization | Acknowledged at (s) | Remaining index drain (s) | Create + index (s) |
| --- | ---: | ---: | ---: |
| 000000000000000000000001 | 34.37 | 227.98 | 262.35 |
| 000000000000000000000002 | 34.41 | 227.80 | 262.21 |
| 000000000000000000000003 | 34.45 | 227.97 | 262.42 |
| 000000000000000000000004 | 34.49 | 227.95 | 262.44 |

Combined create/index wall time: 262.44 s. Throughput: 1524 records/s. Peak process RSS: 2750.4 MiB.

Per-organization timings overlap and must not be summed. Telemetry, disk writes and indexing share the process. This diagnostic does not include the standard sustained workloads. Correctness checks: {"uuidReads":"passed","indexedReads":"passed","separateDirectories":"passed","updateAndDeleteIsolation":"passed"}.
