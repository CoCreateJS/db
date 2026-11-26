# Parallel organization benchmark

Status: passed. One process, 8 concurrent organization Trees, 100,000 records each.

| Organization | Acknowledged at (s) | Remaining index drain (s) | Create + index (s) |
| --- | ---: | ---: | ---: |
| 000000000000000000000001 | 69.67 | 599.75 | 669.42 |
| 000000000000000000000002 | 69.71 | 600.13 | 669.84 |
| 000000000000000000000003 | 69.75 | 600.46 | 670.21 |
| 000000000000000000000004 | 69.83 | 600.73 | 670.56 |
| 000000000000000000000005 | 69.87 | 599.94 | 669.81 |
| 000000000000000000000006 | 69.91 | 599.68 | 669.59 |
| 000000000000000000000007 | 69.95 | 599.77 | 669.72 |
| 000000000000000000000008 | 69.99 | 600.45 | 670.44 |

Combined create/index wall time: 670.57 s. Throughput: 1193 records/s. Peak process RSS: 4152.3 MiB.

Per-organization timings overlap and must not be summed. Telemetry, disk writes and indexing share the process. This diagnostic does not include the standard sustained workloads. Correctness checks: {"uuidReads":"passed","indexedReads":"passed","separateDirectories":"passed","updateAndDeleteIsolation":"passed"}.
