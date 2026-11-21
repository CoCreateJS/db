# 100K Disk-First Create — Partial Diagnostic

The memory-acknowledgement run was intentionally stopped after **1 h 50 m 8 s**. It had persisted **73,750 of 100,000 object leaves** across 295 completed 250-object requests. At that point the process had about **1,581 MiB peak RSS** (Linux high-water mark) and 3,606 branch files on disk.

This is not a completed benchmark: full-run elapsed time, final peak RSS and the 100K completion check are unavailable. It nevertheless shows a severe throughput bottleneck at this workload size, so completing this pass and then running a matching 100K disk-ack pass would consume several more hours.

For context, the completed 10K comparison took about 130 seconds and showed nearly identical peak RSS for memory and disk acknowledgement. The partial 100K run does not establish whether acknowledgement modes differ at 100K.

- [Partial raw snapshot](disk-first-create-100k-memory-interrupted-2026-11-21.json)
- [Completed 10K comparison](disk-first-create-10k-comparison-2026-11-21.md)
