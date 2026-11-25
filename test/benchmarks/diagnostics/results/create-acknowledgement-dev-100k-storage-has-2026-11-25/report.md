# CoCreateDB Create Acknowledgement and Index Drain

- Run: 2026-11-25T20-24-00.283Z; passed 1/1.
- Fixture: shared lifecycle fixture v3 with supplied UUIDs, 100000; hash is recorded per run.
- Mode: adaptive; acknowledgement: memory; memory allocation: 75%; deferred tree indexing enabled.
- Each trial uses a fresh Node process and isolated temporary DB directory. Values are medians across independent trials.
- Create acknowledgement measures elapsed time awaiting `object.create` responses. Index drain measures the remaining `flushIndex()` time after the create responses; background indexing may already have progressed during creation.
- The benchmark verifies the last created leaf can be read directly by UUID before the index drain finishes.
- New leaves enter the resident map before deferred index entries are constructed; the UUID read check confirms map availability before index drain.

| Metric | Median |
| --- | ---: |
| Single create acknowledgement p50 | 0.381 ms |
| Single create acknowledgement p95 | 0.959 ms |
| Single create index drain | 69.418 ms |
| 100,000 create acknowledgement requests | 7156.902 ms |
| 100,000 acknowledgement throughput | 13,973 records/s |
| Pending leaves after acknowledgement | 100,000 |
| Remaining index drain after acknowledgement | 103134.911 ms |
| Create to fully indexed wall time | 111234.539 ms |
| Peak RSS | 979.25 MiB |

Fixture preparation is timed separately and excluded from acknowledgement request time. Index work can overlap with the create loop, so acknowledgement time and post-ack drain are separate phases, not additive estimates of total index CPU time.

Raw per-run results and source hashes are in this directory.
