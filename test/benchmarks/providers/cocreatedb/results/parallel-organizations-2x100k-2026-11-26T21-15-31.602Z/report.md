# Parallel organization benchmark

Status: passed. One process, two concurrent organization Trees, 100,000 records each.

| Organization | Acknowledged at (s) | Remaining index drain (s) | Create + index (s) |
| --- | ---: | ---: | ---: |
| 000000000000000000000001 | 15.79 | 140.04 | 155.84 |
| 000000000000000000000002 | 15.83 | 140.05 | 155.87 |

Combined create/index wall time: 155.87 s. Throughput: 1283 records/s. Peak process RSS: 1401.4 MiB.

Per-organization timings overlap and must not be summed. Telemetry, disk writes and indexing share the process. This diagnostic does not include the standard sustained workloads. Correctness checks: {"uuidReads":"passed","indexedReads":"passed","separateDirectories":"passed","updateAndDeleteIsolation":"passed"}.
