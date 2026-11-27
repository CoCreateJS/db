# Parallel organization benchmark

Status: passed. One process, 5 concurrent organization Trees, 100,000 records each.

| Organization | Acknowledged at (s) | Remaining index drain (s) | Create + index (s) |
| --- | ---: | ---: | ---: |
| 000000000000000000000001 | 44.38 | 294.48 | 338.86 |
| 000000000000000000000002 | 44.42 | 294.49 | 338.90 |
| 000000000000000000000003 | 44.46 | 294.55 | 339.01 |
| 000000000000000000000004 | 44.50 | 294.32 | 338.82 |
| 000000000000000000000005 | 44.57 | 294.31 | 338.88 |

Combined create/index wall time: 339.01 s. Throughput: 1475 records/s. Peak process RSS: 3125.0 MiB.

Per-organization timings overlap and must not be summed. Telemetry, disk writes and indexing share the process. This diagnostic does not include the standard sustained workloads. Correctness checks: {"uuidReads":"passed","indexedReads":"passed","separateDirectories":"passed","updateAndDeleteIsolation":"passed"}.
