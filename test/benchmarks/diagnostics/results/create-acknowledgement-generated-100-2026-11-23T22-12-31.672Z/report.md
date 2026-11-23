# CoCreateDB Create Acknowledgement and Index Drain

- Run: 2026-11-23T22-12-31.672Z; passed 1/1.
- Fixture: shared lifecycle fixture v3 with generated UUIDs, 100; hash is recorded per run.
- Mode: adaptive; acknowledgement: memory; memory allocation: 75%; deferred tree indexing enabled.
- Each trial uses a fresh Node process and isolated temporary DB directory. Values are medians across independent trials.
- Create acknowledgement measures elapsed time awaiting `object.create` responses. Index drain measures the remaining `flushIndex()` time after the create responses; background indexing may already have progressed during creation.
- The benchmark verifies the last created leaf can be read directly by UUID before the index drain finishes.
- `createLeaf()` currently constructs its per-key Entry metadata synchronously; this measures deferred tree insertion, not a leaf-only implementation.

| Metric | Median |
| --- | ---: |
| Single create acknowledgement p50 | 0.067 ms |
| Single create acknowledgement p95 | 0.124 ms |
| Single create index drain | 38.275 ms |
| 100 create acknowledgement requests | 2.082 ms |
| 100 acknowledgement throughput | 48,040 records/s |
| Pending leaves after acknowledgement | 0 |
| Remaining index drain after acknowledgement | 39.976 ms |
| Create to fully indexed wall time | 46.426 ms |
| Peak RSS | 71.17 MiB |

Fixture preparation is timed separately and excluded from acknowledgement request time. Index work can overlap with the create loop, so acknowledgement time and post-ack drain are separate phases, not additive estimates of total index CPU time.

Raw per-run results and source hashes are in this directory.
