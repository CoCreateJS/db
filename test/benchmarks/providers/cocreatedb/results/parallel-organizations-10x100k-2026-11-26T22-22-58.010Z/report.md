# Parallel organization benchmark

Status: passed. One process, 10 concurrent organization Trees, 100,000 records each.

| Organization | Acknowledged at (s) | Remaining index drain (s) | Create + index (s) |
| --- | ---: | ---: | ---: |
| 000000000000000000000001 | 96.27 | 994.09 | 1090.36 |
| 000000000000000000000002 | 96.32 | 994.80 | 1091.12 |
| 000000000000000000000003 | 96.37 | 993.46 | 1089.83 |
| 000000000000000000000004 | 96.41 | 994.06 | 1090.47 |
| 000000000000000000000005 | 96.45 | 993.95 | 1090.40 |
| 000000000000000000000006 | 96.51 | 994.42 | 1090.92 |
| 000000000000000000000007 | 96.55 | 994.26 | 1090.81 |
| 000000000000000000000008 | 96.62 | 992.34 | 1088.97 |
| 000000000000000000000009 | 96.67 | 991.14 | 1087.86 |
| 00000000000000000000000a | 96.71 | 991.93 | 1088.64 |

Combined create/index wall time: 1091.13 s. Throughput: 916 records/s. Peak process RSS: 5081.9 MiB.

Per-organization timings overlap and must not be summed. Telemetry, disk writes and indexing share the process. This diagnostic does not include the standard sustained workloads. Correctness checks: {"uuidReads":"passed","indexedReads":"passed","separateDirectories":"passed","updateAndDeleteIsolation":"passed"}.
