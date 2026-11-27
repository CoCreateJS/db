# Partial run snapshot: 80 organizations × 25,000 records

**Status: incomplete; stopped before index queues drained.** This is a diagnostic snapshot, not a passing benchmark or a completed throughput result.

The run used 8 Node worker processes, 80 organizations, 4 arrays per organization (320 arrays total), seeded randomized assignment, and load-only mode. At the last queue progress log, elapsed time was 2,359,957 ms (39 min 20 s), with 658,240 pending index items; the initial observed pending count was 1,819,680. These counters are pending index leaves, not a verified count of records already queryable.

A concurrent host snapshot showed the benchmark primary at 21.6% CPU and workers between 14.1% and 16.1% CPU. `iostat` showed NVMe write activity around 3,006 writes/s and 24,012 KiB/s, 7.58 ms write await, and 97% device utilization; CPU I/O wait was 64.49%. These observations support substantial storage pressure during the run, but the measurements are host-wide and do not isolate the benchmark's exact share.

The benchmark was stopped to preserve this baseline before changing disk settings. Detailed in-process CPU samples, final Tree ownership, post-index memory, and total create-plus-index time were not produced. See [partial snapshot](partial-snapshot.json).
