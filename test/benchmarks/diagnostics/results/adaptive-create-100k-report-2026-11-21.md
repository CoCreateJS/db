# Default Adaptive 100K Create Diagnostic

This run used the residency diagnostic fixture and 100,000 records in 400 sequential requests of 250 objects each. Mode, acknowledgement, memory policy and indexing options were omitted, so the DB used its defaults: adaptive mode, memory acknowledgement, a 25% memory budget, and deferred indexing.

| Measurement | Result |
| --- | ---: |
| Create response loop | 15.96 s |
| Deferred index drain | 31.10 s |
| Disk/background drain | 13.76 s |
| End-to-end including drains | 60.82 s |
| Peak process RSS | 898.27 MiB |
| Effective mode at end | adaptive |
| Pending index after drain | 0 |
| Object leaves persisted | 100,000 |
| Leaf writes / branch writes | 100,004 / 4,877 |

All 100,000 object leaves were present in both the resident map and the warm on-disk tier at completion. The memory policy's effective budget was 1.91 GiB; it did not switch to disk-first during this run.

This contrasts sharply with the interrupted disk-first run, which processed only 73,750 leaves in 1 h 50 m. That earlier run also disabled memory policy and forced synchronous indexing, so it is not a controlled mode-only comparison. However, this default adaptive run shows that memory acknowledgement itself is fast; the prior bottleneck was in the disk-first/synchronous-indexing path, not waiting for disk acknowledgement.

- [Raw result](adaptive-create-100k-2026-11-21T20-11-26.535Z.json)
- [Interrupted disk-first snapshot](disk-first-create-100k-memory-interrupted-2026-11-21.json)
