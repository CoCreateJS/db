# Direct flattened-key indexing comparison

## Change

`createRecord()` now streams `indexValues(record)` directly into `index.create()` instead of first building a second array of index entries. `indexValues()` calls the existing Utils `objectToDotNotation()` once, then emits its complete flattened keys directly. A small container walk preserves object/array artifacts and empty containers; lazy binary-path handling and binary-reference exclusions preserve the existing binary rules. The previous path splitting, repeated ancestor resolution, intermediate values `Map`, and path-deduplication `Set` are removed. Utils is unchanged.

The grouped terminal index format and query planner are unchanged.

## Benchmark method

Used the established scoped lifecycle runner with 100, 500, and 1,000 documents and 100 operation samples. Each run used Node v24.18.0, Linux x64, two available CPUs, memory-only mode, and the same fields and query mix. Two sequential baseline runs used commit `a2e59a9`; two sequential final runs used the updated source. The reported latency values are medians across those two runs. `/usr/bin/time -v` captured each process's peak RSS.

The runner checks result counts for UUID reads, equality, nested-path and range reads. It also measures batch creation/index flush, UUID updates, and deletion of 25 objects.

## Results at 1,000 documents

| Operation | Baseline | Updated | Change |
| --- | ---: | ---: | ---: |
| Batch create | 257.89 ms | 256.39 ms | -0.6% |
| Index flush | 2,345.05 ms | 2,307.97 ms | -1.6% |
| UUID read p50 | 0.124 ms | 0.099 ms | -19.9% |
| Equality read p50 | 1.262 ms | 1.207 ms | -4.3% |
| Nested-path read p50 | 0.790 ms | 0.759 ms | -4.0% |
| Range read p50 | 3.866 ms | 3.647 ms | -5.7% |
| UUID update p50 | 0.367 ms | 0.349 ms | -4.9% |
| Delete 25 objects | 3.307 ms | 3.197 ms | -3.3% |
| Peak RSS | 153,334 KiB | 158,442 KiB | +3.3% |

At 500 documents, nested-path read p50 rose from 0.520 ms to 0.613 ms (+17.9%) and UUID update p50 from 0.438 ms to 0.485 ms (+10.9%); both are under 0.1 ms absolute differences. At 100 documents, nested-path p50 rose 10.4% (0.290 ms to 0.320 ms). Other 100- and 500-document timings were mixed and close. This small benchmark does not show a consistent operation-wide regression. RSS is process peak, not a heap snapshot; it was about 5 MiB higher in the two final runs and should be treated as a small observed increase, not a memory win.

## Correctness checks

- `test/property-paths.test.js` and `test/coson-artifact.test.js`: 3/3 passed, covering nested containers, empty object/array paths, array continuity, binary metadata exclusions, and index-candidate reads.
- Standard lifecycle benchmark: all expected result counts passed for its UUID, equality, nested-path, and range reads at all three dataset sizes.
- High-level create/read smoke check: 5/5 expected queries passed over nested empty containers, arrays, null/boolean/string/number values, and object-in-array paths.

The change is retained: it removes the per-record index-entry array and repeated path/ancestor work, while the 1,000-document workload is modestly faster overall. Small-set timing variance and the observed RSS increase remain documented tradeoffs.

## Raw runs

- Baseline: `results/run-2026-11-19T04-46-34.435Z.json`, `results/baseline-run-2026-11-19T04-58-32.874Z.json`
- Updated: `results/run-2026-11-19T04-53-31.293Z.json`, `results/run-2026-11-19T04-57-11.964Z.json`
