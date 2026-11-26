# Parallel organization benchmark

Status: passed. One process, two concurrent organization Trees, 100,000 records each.

| Organization | Acknowledged at (s) | Remaining index drain (s) | Create + index (s) |
| --- | ---: | ---: | ---: |
| 000000000000000000000001 | 18.31 | 136.05 | 154.36 |
| 000000000000000000000002 | 18.35 | 136.07 | 154.42 |

Combined create/index wall time: 154.42 s. Throughput: 1295 records/s. Peak process RSS: 1397.9 MiB.

Per-organization timings overlap and must not be summed. Telemetry, disk writes and indexing share the process. This diagnostic does not include the standard sustained workloads. Correctness checks: {"uuidReads":"passed","indexedReads":"passed","separateDirectories":"passed","updateAndDeleteIsolation":"passed"}.
