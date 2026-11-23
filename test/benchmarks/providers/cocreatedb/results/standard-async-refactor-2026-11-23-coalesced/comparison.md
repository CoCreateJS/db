# 100K Benchmark Comparison

Compared the five-run standard result in `standard-2026-11-22T00-15-14.033Z` with this five-run async-refactor result.

## Conditions

- Both runs passed 5/5 trials and used the same fixture v3 hash: `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b`.
- Both used Node v24.18.0, Linux x64, AMD EPYC 7571 (2 logical CPUs), adaptive mode, memory acknowledgement, 75% allocation, 10 warmups, 40 latency samples, and 5-second sustained workloads at concurrency 1 and 8.
- Benchmark runner isolates each run in a temporary database directory. The earlier runner used the user's configured path; this run used isolated temporary paths. The fixture and measured workload are unchanged.
- Source identity: baseline `9558a965ed301e6ceeebef764eeabed549471255`; async refactor commit `fbd2950c861b8481780653c9fb26caea41f4f2f2`, with working-tree source hashes recorded in `source-sha256.txt`.

## Overall

| Metric | Previous | Async refactor | Change |
| --- | ---: | ---: | ---: |
| Median create + index | 34,166 ms (2,927 objects/s) | 78,676 ms (1,271 objects/s) | 2.30x slower |
| Median total run time | 86,810 ms | 111,230 ms | +28.1% |
| Loaded RSS | 675.39 MiB | 674.79 MiB | -0.1% |
| Peak RSS | 939.61 MiB | 851.90 MiB | -9.3% |
| CPU utilization | 104.0% | 116.3% | +12.3 percentage points |

## Operation medians

Latency p50 and throughput are medians across the five independent runs.

| Operation | Previous p50 | Async p50 | p50 change | Previous ops/s | Async ops/s | Throughput change |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Single create | 0.502 ms | 1.032 ms | +105.6% | 1,806 | 849 | -53.0% |
| UUID read | 0.070 ms | 0.045 ms | -34.9% | 12,075 | 19,480 | +61.3% |
| Equality | 0.686 ms | 1.095 ms | +59.5% | 1,172 | 750 | -36.0% |
| Nested equality | 0.642 ms | 1.008 ms | +57.1% | 1,315 | 893 | -32.1% |
| Numeric range | 0.427 ms | 0.925 ms | +116.8% | 2,098 | 998 | -52.4% |
| AND query | 2.878 ms | 6.009 ms | +108.8% | 297 | 162 | -45.4% |
| OR query | 1.446 ms | 3.098 ms | +114.2% | 633 | 309 | -51.2% |
| Single key update | 0.207 ms | 0.234 ms | +13.0% | 4,489 | 3,522 | -21.5% |
| Indexed key update | 0.251 ms | 0.217 ms | -13.4% | 3,453 | 3,914 | +13.4% |
| Numeric increment | 0.255 ms | 0.267 ms | +4.7% | 3,450 | 3,746 | +8.6% |
| Single delete | 19.334 ms | 0.491 ms | -97.5% | 51 | 1,795 | +3,406% |

## Sustained throughput

| Workload | Concurrency | Previous ops/s | Async ops/s | Change |
| --- | ---: | ---: | ---: | ---: |
| Read | 1 | 18,237 | 69,006 | +278% |
| Read | 8 | 22,099 | 86,290 | +290% |
| Write | 1 | 4,710 | 5,785 | +22.8% |
| Write | 8 | 5,535 | 6,553 | +18.4% |
| Mixed | 1 | 7,791 | 10,952 | +40.6% |
| Mixed | 8 | 8,427 | 11,799 | +40.0% |

## Interpretation and limits

The refactor has a clear bulk-ingestion and query regression, despite better sustained throughput, UUID reads, deletes, and lower peak RSS. The request queue added to protect the mutable tree from overlapping CRUD operations is a likely contributor to slower create/index and query timings; this benchmark alone does not isolate that cause. The large single-delete gain also warrants a correctness-focused check before treating it as a general performance win.

The new report could not capture the requested/effective memory budget: `memoryPolicy` contains only `requestedPercent`, while the earlier run recorded total, available, requested-budget, and effective-budget bytes. The resident RSS measurements are still available, but memory-policy headroom is not directly comparable. No external persistence was configured; local Warm disk writes are queued after memory acknowledgement and excluded from request timings.
