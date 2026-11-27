# Parallel organization benchmark

Status: passed. One process, 10 concurrent organization Trees, 1,000 records each.

| Organization | Acknowledged at (s) | Remaining index drain (s) | Create + index (s) |
| --- | ---: | ---: | ---: |
| 000000000000000000000001 | 0.91 | 5.03 | 5.95 |
| 000000000000000000000002 | 1.04 | 4.86 | 5.90 |
| 000000000000000000000003 | 1.08 | 4.83 | 5.92 |
| 000000000000000000000004 | 1.13 | 4.80 | 5.93 |
| 000000000000000000000005 | 1.17 | 4.74 | 5.91 |
| 000000000000000000000006 | 1.22 | 4.69 | 5.91 |
| 000000000000000000000007 | 1.28 | 4.63 | 5.91 |
| 000000000000000000000008 | 1.33 | 4.61 | 5.93 |
| 000000000000000000000009 | 1.38 | 4.57 | 5.95 |
| 00000000000000000000000a | 1.43 | 4.51 | 5.94 |

Combined create/index wall time: 5.95 s. Throughput: 1681 records/s. Peak process RSS: 285.9 MiB.

Per-organization timings overlap and must not be summed. Telemetry, disk writes and indexing share the process. This diagnostic does not include the standard sustained workloads. Correctness checks: {"uuidReads":"passed","indexedReads":"passed","separateDirectories":"passed","updateAndDeleteIsolation":"passed"}.
