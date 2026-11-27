# Parallel organization benchmark

Status: passed. One process, 3 concurrent organization Trees, 100,000 records each.

| Organization | Acknowledged at (s) | Remaining index drain (s) | Create + index (s) |
| --- | ---: | ---: | ---: |
| 000000000000000000000001 | 24.88 | 175.52 | 200.40 |
| 000000000000000000000002 | 24.92 | 175.46 | 200.38 |
| 000000000000000000000003 | 24.96 | 175.48 | 200.43 |

Combined create/index wall time: 200.43 s. Throughput: 1497 records/s. Peak process RSS: 2478.3 MiB.

Per-organization timings overlap and must not be summed. Telemetry, disk writes and indexing share the process. This diagnostic does not include the standard sustained workloads. Correctness checks: {"uuidReads":"passed","indexedReads":"passed","separateDirectories":"passed","updateAndDeleteIsolation":"passed"}.
