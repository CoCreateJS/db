# Interrupted index lifecycle run

Status: stopped before index readiness. Intended workload: one organization, 80 arrays × 25,000 records (2,000,000 creates), using batches of 500 records per array request. The benchmark did not receive a live progress snapshot before termination, so acknowledged create count, pending queues, and measured disk operations per second are unknown. This was create-only; update/delete/read phases were not run.

After termination, the temporary adapter directory contained 33 finalized file artifacts (32 leaf files and one config file) and 17 staged .tmp files (16 leaf files and one config file). These filesystem artifacts do not establish create acknowledgement counts or a trustworthy disk throughput rate. The last process sample before termination was at about 134 seconds, with 6,026,784 KiB RSS and 134% process CPU since start.

This partial result is not comparable with completed index-ready benchmarks.
