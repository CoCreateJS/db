# Disk coalescing and concurrency investigation

All seven cases passed creation, indexed updates, deletion, cold index hydration and final count checks. Each uses 10,000 lifecycle-v3 base records, then 1,000 individual creates, updates and deletes. Index and terminal sizes are 64, matching the large worker-affinity benchmark. One fresh process and one organization per case; no external Persistence adapter. Cases run sequentially on the same EBS-backed host. No production implementation or default was changed.

File counters wrap the actual filesystem writeFile/rename calls used by @cocreate/disk, after its queue coalesces requests. A one-file probe verified the hook. Counting occurs only under each test directory and stops before cleanup. API completion counts were checked against actual file write counts for leaves and branches. Built-in methods are restored after each process run.

## Coalescing at the existing default (case 1)

| Phase | Branch requests | Branch file writes | Submitted branch MB | Written branch MB | Stored elapsed (s) |
| --- | ---: | ---: | ---: | ---: | ---: |
| bulkCreate | 7,034 | 5,276 | 15.33 | 9.40 | 5.105 |
| singleCreate | 51,503 | 3,271 | 243.76 | 12.48 | 3.650 |
| singleUpdate | 32 | 32 | 0.05 | 0.05 | 0.284 |
| singleDelete | 263 | 263 | 0.68 | 0.68 | 0.292 |

For individual creates, 51,503 branch requests became 3,271 actual branch writes: 93.6% fewer calls. Submitted branch data was 243.76 MB; 12.48 MB reached writeFile: 94.9% less. Grouping and coalescing are functioning. Grouping itself does not combine separate UUID files into one filesystem operation.

## Concurrency/thread-pool sweep

| Case | Disk concurrency | Thread pool | Summed phase storage time (s) | Branch file writes | Written branch MB |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 16 | 4 | 9.330 | 8,842 | 22.61 |
| 2 | 32 | 4 | 8.923 | 12,655 | 41.99 |
| 3 | 16 | 8 | 9.936 | 8,843 | 22.62 |
| 4 | 32 | 8 | 10.163 | 12,649 | 41.90 |
| 5 | 16 | 4 | 8.910 | 8,843 | 22.62 |
| 6 | 8 | 4 | 9.585 | 7,157 | 15.60 |
| 7 | 8 | 4 | 9.474 | 7,157 | 15.60 |

The repeated 16/4 baseline ranges from 8.910 to 9.330 seconds. The 32/4 case is within that range but issues about 43% more branch file writes. Raising the thread pool to eight did not improve overall storage completion. The repeated 8/4 cases reduce branch writes by about 19% and favor individual-create throughput, but are slower overall because bulk creation loses time. These samples do not justify changing the default of 16/4.

## Storage pressure and limitations

The user-provided 3,000 IOPS and 125 MiB/s are independent ceilings. At 3,000 operations/s, reaching 125 MiB/s would require an average transfer of about 42.7 KiB. Many small file/metadata operations can hit an IOPS limit well below the bandwidth ceiling. One file write is not one EBS I/O: filesystem metadata, temporary-file creation, rename, caching and block merging affect the relationship.

These are small buffered workloads. For example, case 1 bulk creation wrote files through the OS while the device snapshot recorded only 4 KiB of block writes during that phase; later phases observed writeback. Device deltas are host-wide, can include earlier phases/cleanup/background activity, and are not direct per-case attribution. File-completion timers do not imply fsync/power-loss durability. This test cannot establish the sustained EBS ceiling under the original two-million-record pressure, or extrapolate its exact post-coalescing bytes.

The large report counted submitted requests/bytes before coalescing. The small tests prove those figures can greatly exceed actual file writes; the reported 65.3 GB must not be called confirmed physical disk traffic. The large run's 28.6% I/O wait and backlog remain evidence of real storage pressure, but exact device saturation still requires device/CloudWatch measurements during that workload.

Recommended next measurement: retain grouping and defaults, add these post-coalescing file counters and device I/O observations to the next large worker-affinity run, then choose changes from actual writes, payload sizes, queue drain and storage latency. Avoid a new batching/queue architecture based on submitted-byte totals.

Reproduce with `node test/benchmarks/diagnostics/disk-coalescing.mjs`. The script runs all seven cases; BENCH_RECORDS, BENCH_MUTATIONS, BENCH_OUTPUT_DIR and BENCH_BLOCK_DEVICE control the fixture/output/device. Exact raw phase counts and observed device deltas are in case-1.json through case-7.json. All sizes marked MB use decimal bytes; MiB/s uses binary units.
