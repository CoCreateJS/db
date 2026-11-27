# Parallel organization benchmark

Status: passed. One process, 16 concurrent organization Trees, 25,000 records each.

| Organization | Acknowledged at (s) | Remaining index drain (s) | Create + index (s) |
| --- | ---: | ---: | ---: |
| 000000000000000000000001 | 38.26 | 193.29 | 231.55 |
| 000000000000000000000002 | 38.30 | 193.26 | 231.56 |
| 000000000000000000000003 | 38.34 | 193.20 | 231.53 |
| 000000000000000000000004 | 38.37 | 192.99 | 231.36 |
| 000000000000000000000005 | 38.42 | 192.93 | 231.35 |
| 000000000000000000000006 | 38.45 | 193.11 | 231.56 |
| 000000000000000000000007 | 38.50 | 192.92 | 231.42 |
| 000000000000000000000008 | 38.56 | 192.85 | 231.41 |
| 000000000000000000000009 | 38.66 | 192.79 | 231.45 |
| 00000000000000000000000a | 38.71 | 192.74 | 231.45 |
| 00000000000000000000000b | 38.75 | 192.80 | 231.54 |
| 00000000000000000000000c | 38.79 | 192.47 | 231.26 |
| 00000000000000000000000d | 38.83 | 192.61 | 231.44 |
| 00000000000000000000000e | 38.87 | 192.65 | 231.52 |
| 00000000000000000000000f | 38.91 | 192.53 | 231.44 |
| 000000000000000000000010 | 38.95 | 192.62 | 231.57 |

Combined create/index wall time: 231.57 s. Throughput: 1727 records/s. Peak process RSS: 2852.9 MiB.

Per-organization timings overlap and must not be summed. Telemetry, disk writes and indexing share the process. This diagnostic does not include the standard sustained workloads. Correctness checks: {"uuidReads":"passed","indexedReads":"passed","separateDirectories":"passed","updateAndDeleteIsolation":"passed"}.
