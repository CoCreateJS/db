# CoCreateDB live-reference core comparison

Checkpoint: `3244ff0` on the DB `dev` branch. Current result: the uncommitted live-reference refactor.

| Warm operation | Checkpoint median / p95 | Live-reference median / p95 | Measured clone calls: checkpoint / live |
| --- | ---: | ---: | ---: |
| file | 1.859 / 2.270 ms | 0.523 / 0.808 ms | 1,200 / 0 |
| render | 237.056 / 269.044 ms | 83.314 / 105.359 ms | 54,700 / 0 |

## Workload

- 73 public source documents from the App fixture used in the earlier isolated benchmark. Both modes use the current Utils and renderer, the same source data, scope, query envelopes, and default 128 KiB preferred node size.
- Production primary DB integration with a server harness; worker IPC, Socket, authorization, live network delivery, and external persistence are excluded. Mesh messages are counted, not delivered to another process. Both DB caches are warm before measured operations.
- Five file-read warmups and three render warmups. Fifty measured file reads and twenty measured renders, sequentially, in separate processes for each mode. Timings are inside the process around `db.send()`/direct rendering. These are latency samples, not sustained-load throughput or HTTP timings.
- Every render resolves 114 file reads, returns 120,860 bytes, and has the same SHA-256: `22275bc465d00f584291f5ec20f3d8ae599b6fb7c99a3b7136270e97f5d663c0`.
- `structuredClone` is counted in the checkpoint. The live run throws if anything calls it during warmups or measurements. It completes with zero calls.
- The live run uses `memoryOnly: true`: it creates no DB directory, invokes no persistence adapter, and makes no provider requests. The checkpoint has no memory-only option: it seeds temporary files with immediate local persistence outside the measured intervals, then serves from its populated cache. Seed times are retained only for context and are not a comparable write-performance result.
- The checkpoint baseline is a source archive of commit `3244ff0`, not the earlier pre-staged source snapshot. Both runs use currently installed dependencies. The live diagnostic server remains separate and was not restarted with this refactor. Ambient system load can affect these samples.

## Behavior and validation

Cache reads, optional index caching, create/read values, and distribution payloads retain live references. Updates prepare changed property slots, validate with the shared update utility, then attach them. No generic tree rollback journal or document/node snapshots are used in the core. Previous index state is represented by keys/scalars/array digests. Queued patches resolve their values from the live record at serialization time. Index splits splice data into new sibling nodes and retain the original node object.

The node size is a split target, not a rejection limit. An indivisible entry and minimum-fanout nodes can exceed it. Persistent structural failures remain inspectable as pending errors and do not run an endless background retry loop. Routine progress/retry console logging remains absent.

The focused core test run passed 306 tests, covering indexes, query/update operators, scopes, distribution, reference identity, and real worker IPC. A subsequent seven-test live-reference run also passed, adding explicit validation-before-attachment, no-indexing-on-repeated-read, node-identity-through-splits/partition-delivery, zero-clone assertions, no DB files, and no endless retry after an unexpected publication failure.

Persistence implementation files are unchanged from the checkpoint. The old immutable-snapshot/rollback persistence suite is not acceptance for this phase; its semantics need a separate review before enabling persistence with the new reference contract. Some legacy filesystem-mode regression cases were included in the focused operator/index tests, but this is not a full durability or live-provider validation. Real multi-server eventual consistency and memory eviction remain outside these tests.

## Reproduction

The benchmark requires an archive of the checkpoint and a dependency link:

```bash
cd /home/ubuntu/Dev/CoCreateJS/modules/db
task_snapshot=$(mktemp -d /tmp/coc-db-live-baseline-XXXXXX)
git archive 3244ff0 | tar -x -C "$task_snapshot"
ln -s /home/ubuntu/Dev/CoCreateJS/modules/db/node_modules "$task_snapshot/node_modules"
printf '%s\n' "$task_snapshot" > /tmp/coc-db-live-baseline-path
cd /home/ubuntu/Dev/CoCreateJS/modules/db
node test/benchmarks/db-live-references-20261112/benchmark.mjs checkpoint
node test/benchmarks/db-live-references-20261112/benchmark.mjs live
```

Raw samples, hashes, clone counts, and retained-cache estimates are in `checkpoint.json` and `live.json`. Source fingerprints are in `source-fingerprints.json`. Cache serialized-byte estimates are not heap measurements; no physical memory reduction is claimed from them.
