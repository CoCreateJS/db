# 100K CoCreateDB, MongoDB and Redis Comparison

Positive percentages mean CoCreateDB delivered higher throughput; negative percentages mean lower throughput. Values are five-run medians, except the new deferred-create diagnostic's single-create acknowledgement, which is also a five-run median.

## Create and index

The CoCreateDB diagnostic separates acknowledgement from index drain. Its 100K create acknowledgement requests took 85.20 seconds (1,174 records/s). The wall time to become fully indexed, excluding fixture preparation, was 85.21 seconds. The remaining index backlog after acknowledgements was only 1.20 ms because indexing ran concurrently and kept up with the incoming requests.

| Provider and measured contract | Time | Throughput | CoCreateDB throughput difference |
| --- | ---: | ---: | ---: |
| CoCreateDB deferred create acknowledgement | 85,200.957 ms | 1,174 records/s | — |
| CoCreateDB create to indexed | 85,209.353 ms | 1,174 records/s | — |
| MongoDB bulk load + index maintenance | 7,091.419 ms | 14,102 records/s | **−91.7%** vs CoCreateDB acknowledgement |
| Redis JSON + RediSearch load + index maintenance | 12,844.029 ms | 7,786 records/s | **−84.9%** vs CoCreateDB acknowledgement |

These bulk figures are not the same contract: MongoDB and Redis figures include load and index maintenance; CoCreateDB's acknowledgement ends when the create requests have returned, while its indexer runs in the background. CoCreateDB's measured create-to-indexed wall time is shown separately and is nearly identical to its acknowledgement duration because background indexing keeps pace. The result should not be read as indexing costing only 1.20 ms; that is only the work left after acknowledgements.

## Single-create acknowledgement and other operations

The CoCreateDB single-create row uses the new deferred-index acknowledgement measurement (p50 0.911 ms, p95 1.706 ms; 970 ops/s). Other CoCreateDB rows use the latest standard run, which indexes synchronously for those operation measurements. Percentages compare throughput.

| Metric | vs. MongoDB | vs. Redis JSON + RediSearch |
| --- | ---: | ---: |
| Single create acknowledgement | **−36.2%** | **−65.6%** |
| UUID read | +1,577% | +316% |
| Equality | +134% | +374% |
| Nested equality | +136% | +243% |
| Numeric range | +128% | +695% |
| AND query | **−63.2%** | +11.1% |
| OR query | **−22.9%** | +191% |
| Single key update | +242% | +37.3% |
| Indexed key update | +171% | n/a |
| Numeric increment | +227% | +24.2% |
| Single delete | +36.0% | **−10.6%** |

## Sustained throughput

| Workload | Concurrency | vs. MongoDB | vs. Redis JSON + RediSearch |
| --- | ---: | ---: | ---: |
| Read | 1 | +3,512% | +1,259% |
| Write | 1 | +218% | +80.2% |
| Mixed | 1 | +481% | +179% |
| Read | 8 | +2,310% | +249% |
| Write | 8 | +106% | **−3.5%** |
| Mixed | 8 | +256% | +19.2% |

## Win/loss count and interpretation

- Including the contract-mismatched bulk-load comparison: CoCreateDB leads on 14 of 18 reported metrics against MongoDB and trails on 4; against Redis, it leads on 13 of 17 available metrics and trails on 4.
- Excluding bulk load to compare operation and sustained throughput only: CoCreateDB leads on 14 of 17 metrics against MongoDB and trails on 3; against Redis, it leads on 13 of 16 available metrics and trails on 3.
- The operation/sustained losses are single create acknowledgement, AND, and OR against MongoDB; single create acknowledgement, single delete, and concurrency-8 writes against Redis. Redis did not provide an indexed-key-update metric.

All providers used the same lifecycle fixture v3 hash: `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b`. CoCreateDB used adaptive mode, memory acknowledgement, 75% memory allocation, and deferred tree indexing for the new acknowledgement diagnostic. MongoDB used a separate process over loopback TCP with `w:1,j:false`; Redis used a separate process over TCP with RDB and AOF disabled; CoCreateDB ran in-process and queues local Warm writes after memory acknowledgement. These setup and durability differences make especially large in-process read advantages directional rather than a hardware-neutral ranking.

The diagnostic confirms direct UUID lookup succeeds before index drain finishes. It measures deferred tree insertion, but `createLeaf()` still constructs per-key Entry metadata synchronously, so this is not yet a leaf-only create path.

## Source reports

- CoCreateDB acknowledgement and index drain: `report.md` and the five raw trial JSON files in this directory.
- CoCreateDB steady-state baseline: `../../providers/cocreatedb/results/standard-async-refactor-2026-11-23-coalesced/report.md`.
- MongoDB: `../../providers/mongodb/results/mongodb-standard-2026-11-20T04-08-28.702Z/report.md`.
- Redis: `../../providers/redis/results/redis-standard-2026-11-20T04-58-00.174Z/report.md`.
