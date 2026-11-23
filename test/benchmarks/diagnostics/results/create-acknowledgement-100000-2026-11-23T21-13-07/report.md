# CoCreateDB Create Acknowledgement and Index Drain

- Run: 2026-11-23T21-13-11.012Z; passed 5/5.
- Fixture: shared lifecycle fixture v3, 100K; hash 79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b.
- Mode: adaptive; acknowledgement: memory; memory allocation: 75%; deferred tree indexing enabled.
- Each trial uses a fresh Node process and isolated temporary DB directory. Values are medians across independent trials.
- Create acknowledgement measures elapsed time awaiting `object.create` responses. Index drain measures the remaining `flushIndex()` time after the create responses; background indexing may already have progressed during creation.
- The benchmark verifies the last created leaf can be read directly by UUID before the index drain finishes.
- `createLeaf()` currently constructs its per-key Entry metadata synchronously; this measures deferred tree insertion, not a leaf-only implementation.

| Metric | Median |
| --- | ---: |
| Single create acknowledgement p50 | 0.893 ms |
| Single create acknowledgement p95 | 1.785 ms |
| Single create index drain | 0.659 ms |
| 100K create acknowledgement requests | 57972.183 ms |
| 100K acknowledgement throughput | 1,725 records/s |
| Pending leaves after acknowledgement | 0 |
| Remaining 100K index drain after acknowledgement | 480.560 ms |
| Create to fully indexed wall time | 59310.672 ms |
| Peak RSS | 716.75 MiB |

Fixture preparation is timed separately and excluded from acknowledgement request time. Index work can overlap with the create loop, so acknowledgement time and post-ack drain are separate phases, not additive estimates of total index CPU time.

Raw per-run results and source hashes are in this directory.
