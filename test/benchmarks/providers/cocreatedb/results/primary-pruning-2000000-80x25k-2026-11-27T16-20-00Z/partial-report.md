# Partial 2M one-organization run: default Node heap

**Failed before completion with V8 heap out of memory.** This run used 80 primary Trees × 25,000 records, one organization, with the existing 15-cold / 65-active workload.

The last progress sample was at 700,000 acknowledged records (about 5.4 minutes), with `pendingIndexCount=0`, `pendingDiskCount=489,255`, 4,184 MiB RSS, and no pruning. Node then aborted near its default 4.3 GiB heap limit. This host has 31.1 GiB RAM, compared with 7.7 GiB for the historical 1M pruning benchmark, so the 75% host-memory pressure trigger was not reached before the default V8 heap limit.

This confirms the benchmark must use the intended enlarged Node heap to evaluate the current runtime's host-level pruning behavior on this larger-memory machine. No completed throughput or correctness result is available. Raw partial measurements are in [partial-result.json](partial-result.json).
