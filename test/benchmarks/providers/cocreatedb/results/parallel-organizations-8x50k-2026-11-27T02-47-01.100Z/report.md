# Parallel organization benchmark

Status: passed. One process, 8 concurrent organization Trees, 50,000 records each.

| Organization | Acknowledged at (s) | Remaining index drain (s) | Create + index (s) |
| --- | ---: | ---: | ---: |
| 000000000000000000000001 | 37.75 | 201.81 | 239.57 |
| 000000000000000000000002 | 37.79 | 202.01 | 239.80 |
| 000000000000000000000003 | 37.83 | 201.82 | 239.65 |
| 000000000000000000000004 | 37.91 | 201.90 | 239.81 |
| 000000000000000000000005 | 37.96 | 201.59 | 239.54 |
| 000000000000000000000006 | 38.00 | 201.65 | 239.65 |
| 000000000000000000000007 | 38.03 | 201.45 | 239.48 |
| 000000000000000000000008 | 38.07 | 201.53 | 239.60 |

Combined create/index wall time: 239.81 s. Throughput: 1668 records/s. Peak process RSS: 3000.5 MiB.

Per-organization timings overlap and must not be summed. Telemetry, disk writes and indexing share the process. This diagnostic does not include the standard sustained workloads. Correctness checks: {"uuidReads":"passed","indexedReads":"passed","separateDirectories":"passed","updateAndDeleteIsolation":"passed"}.
