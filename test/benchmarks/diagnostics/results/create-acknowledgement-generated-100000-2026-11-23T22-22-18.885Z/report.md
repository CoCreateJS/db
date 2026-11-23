# CoCreateDB Create Acknowledgement and Index Drain

- Run: 2026-11-23T22-22-18.885Z; passed 5/5.
- Fixture: shared lifecycle fixture v3 with generated UUIDs, 100000; hash is recorded per run.
- Mode: adaptive; acknowledgement: memory; memory allocation: 75%; deferred tree indexing enabled.
- Each trial uses a fresh Node process and isolated temporary DB directory. Values are medians across independent trials.
- Create acknowledgement measures elapsed time awaiting `object.create` responses. Index drain measures the remaining `flushIndex()` time after the create responses; background indexing may already have progressed during creation.
- The benchmark verifies the last created leaf can be read directly by UUID before the index drain finishes.
- `createLeaf()` currently constructs its per-key Entry metadata synchronously; this measures deferred tree insertion, not a leaf-only implementation.

| Metric | Median |
| --- | ---: |
| Single create acknowledgement p50 | 0.067 ms |
| Single create acknowledgement p95 | 0.109 ms |
| Single create index drain | 36.576 ms |
| 100,000 create acknowledgement requests | 1801.081 ms |
| 100,000 acknowledgement throughput | 55,522 records/s |
| Pending leaves after acknowledgement | 0 |
| Remaining index drain after acknowledgement | 40604.476 ms |
| Create to fully indexed wall time | 43894.198 ms |
| Peak RSS | 897.22 MiB |

Fixture preparation is timed separately and excluded from acknowledgement request time. Index work can overlap with the create loop, so acknowledgement time and post-ack drain are separate phases, not additive estimates of total index CPU time.

Raw per-run results and source hashes are in this directory.
