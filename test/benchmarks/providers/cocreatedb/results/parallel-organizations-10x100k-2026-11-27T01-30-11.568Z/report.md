# Parallel organization benchmark

Status: passed. One process, 10 concurrent organization Trees, 100,000 records each.

| Organization | Acknowledged at (s) | Remaining index drain (s) | Create + index (s) |
| --- | ---: | ---: | ---: |
| 000000000000000000000001 | 94.95 | 821.97 | 916.93 |
| 000000000000000000000002 | 95.00 | 826.21 | 921.21 |
| 000000000000000000000003 | 95.06 | 824.04 | 919.10 |
| 000000000000000000000004 | 95.10 | 822.92 | 918.02 |
| 000000000000000000000005 | 95.15 | 805.20 | 900.35 |
| 000000000000000000000006 | 95.19 | 832.58 | 927.76 |
| 000000000000000000000007 | 95.23 | 827.02 | 922.25 |
| 000000000000000000000008 | 95.31 | 820.02 | 915.33 |
| 000000000000000000000009 | 95.35 | 828.02 | 923.37 |
| 00000000000000000000000a | 95.39 | 824.77 | 920.17 |

Combined create/index wall time: 927.76 s. Throughput: 1078 records/s. Peak process RSS: 5422.9 MiB.

Per-organization timings overlap and must not be summed. Telemetry, disk writes and indexing share the process. This diagnostic does not include the standard sustained workloads. Correctness checks: {"uuidReads":"passed","indexedReads":"passed","separateDirectories":"passed","updateAndDeleteIsolation":"passed"}.
