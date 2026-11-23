# 100K Generated-UUID Create: CoCreateDB vs MongoDB and Redis

Positive percentages mean higher CoCreateDB throughput. These are the same 100K provider baselines used in the previous comparison. CoCreateDB generated a UUID because the input omitted it; MongoDB and Redis provider fixtures supplied their UUIDs.

## Single-create acknowledgement

| Provider / operation | p50 acknowledgement | Throughput | CoCreateDB throughput difference |
| --- | ---: | ---: | ---: |
| CoCreateDB, generated UUID | 0.067 ms | 15,350 ops/s | — |
| MongoDB `singleCreate` | 0.637 ms | 1,521 ops/s | **+909.2%** |
| Redis JSON + RediSearch `singleCreate` | 0.348 ms | 2,816 ops/s | **+445.1%** |
| Redis String `singleCreate` (no secondary indexes) | 0.190 ms | 4,461 ops/s | **+244.1%** |

The CoCreateDB number measures returning the created leaf after UUID generation and insertion into its in-memory leaves map. Its indexing and local persistence continue afterward. Provider single-create timings come from their standard request/response operation samples and use fixture-supplied UUIDs; MongoDB uses loopback TCP with `w:1,j:false`, and Redis uses loopback TCP with persistence disabled. These are useful directional comparisons, not equal durability or identity-generation contracts.

## 100K bulk create and index comparison

| Provider / measured stage | Elapsed time | Throughput | CoCreateDB throughput difference |
| --- | ---: | ---: | ---: |
| CoCreateDB generated-UUID acknowledgement | 1,801 ms | 55,522 records/s | — |
| CoCreateDB through index completion | 42,438 ms | 2,356 records/s | — |
| MongoDB bulk load + index maintenance | 7,091 ms | 14,102 records/s | Ack: **+293.7%**; indexed: **−83.3%** |
| Redis JSON + RediSearch load + index maintenance | 12,844 ms | 7,786 records/s | Ack: **+613.1%**; indexed: **−69.7%** |

The acknowledgement row is deliberately separated from index completion: the first metric matches CoCreateDB's response contract, while the provider load figures include index maintenance. The generated-UUID CoCreateDB run responds much sooner, then spends about 40.6 seconds draining deferred index work. The full-index comparison still favors MongoDB and Redis in this workload.

## Conditions and source results

- CoCreateDB generated run: adaptive mode, memory acknowledgement, 75% allocation, deferred indexing; five fresh-process trials. The fixture matches lifecycle v3 except that input UUIDs were removed. Its hash is `5ebaf0a6b003895c10faa0afcd2067b21e346c7d485d53b6707384093682f19f`.
- CoCreateDB supplied-UUID control: same source revision, configuration, and other fixture fields; five trials. Supplied fixture hash: `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b`.
- MongoDB and Redis JSON+RediSearch: existing five-run 100K lifecycle v3 provider baselines, fixture hash `79fd345261896883833b8e006eaf41bf1f1d8e5239f8eb8c24e3fc43abcaac6b`.
- Provider reports document different processes, transports and persistence settings; these figures do not claim equivalent durability.

Reports: [CoCreateDB generated UUID](report.md), [CoCreateDB supplied UUID](../create-acknowledgement-100000-2026-11-23T21-13-07/report.md), [MongoDB](../../../providers/mongodb/results/mongodb-standard-2026-11-20T04-08-28.702Z/report.md), [Redis](../../../providers/redis/results/redis-standard-2026-11-20T04-58-00.174Z/report.md).
