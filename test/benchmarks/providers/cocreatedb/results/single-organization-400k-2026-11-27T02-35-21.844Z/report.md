# Parallel organization benchmark

Status: passed. One process, 1 concurrent organization Trees, 400,000 records each.

| Organization | Acknowledged at (s) | Remaining index drain (s) | Create + index (s) |
| --- | ---: | ---: | ---: |
| 000000000000000000000001 | 30.67 | 361.53 | 392.20 |

Combined create/index wall time: 392.20 s. Throughput: 1020 records/s. Peak process RSS: 2163.0 MiB.

Per-organization timings overlap and must not be summed. Telemetry, disk writes and indexing share the process. This diagnostic does not include the standard sustained workloads. Correctness checks: {"uuidReads":"passed","indexedReads":"passed","separateDirectories":"passed","updateAndDeleteIsolation":"passed"}.
