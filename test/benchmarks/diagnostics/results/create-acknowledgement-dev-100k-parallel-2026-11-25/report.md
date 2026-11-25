# CoCreateDB Create Acknowledgement and Index Drain

- Run: 2026-11-25T20-15-33.018Z; passed 1/1.
- Fixture: shared lifecycle fixture v3 with supplied UUIDs, 100000; hash is recorded per run.
- Mode: adaptive; acknowledgement: memory; memory allocation: 75%; deferred tree indexing enabled.
- Each trial uses a fresh Node process and isolated temporary DB directory. Values are medians across independent trials.
- Create acknowledgement measures elapsed time awaiting `object.create` responses. Index drain measures the remaining `flushIndex()` time after the create responses; background indexing may already have progressed during creation.
- The benchmark verifies the last created leaf can be read directly by UUID before the index drain finishes.
- New leaves enter the resident map before deferred index entries are constructed; the UUID read check confirms map availability before index drain.

| Metric | Median |
| --- | ---: |
| Single create acknowledgement p50 | 0.436 ms |
| Single create acknowledgement p95 | 1.247 ms |
| Single create index drain | 50.682 ms |
| 100,000 create acknowledgement requests | 7432.267 ms |
| 100,000 acknowledgement throughput | 13,455 records/s |
| Pending leaves after acknowledgement | 100,000 |
| Remaining index drain after acknowledgement | 102384.240 ms |
| Create to fully indexed wall time | 110791.472 ms |
| Peak RSS | 1066.83 MiB |

Fixture preparation is timed separately and excluded from acknowledgement request time. Index work can overlap with the create loop, so acknowledgement time and post-ack drain are separate phases, not additive estimates of total index CPU time.

Raw per-run results and source hashes are in this directory.
