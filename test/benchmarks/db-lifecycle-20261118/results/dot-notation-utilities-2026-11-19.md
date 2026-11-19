# CoCreateDB shared dot notation utilities — 2026-11-19

## Changes

CoCreateDB now uses `objectToDotNotation()` from `@cocreate/utils` as the single flattening engine behind `flattenIndexValues()`. An opt-in utility mode retains container references, empty objects and arrays, dense array positions, and binary values. A predicate excludes database metadata and CoSON-owned binary fields. The default utility behavior is unchanged for existing ecosystem callers.

`normalizeObject()` now uses the shared `dotNotationToObject()` to rebuild dotted and bracketed input fields after CoCreateDB's existing metadata filtering and path validation. Index keys remain complete dot-notation strings; query planning, candidate selection, segment traversal, and the index architecture were not changed. Document values remain stored in their original nested shape. Synchronization continues to apply received index partitions directly without regenerating document indexes.

## Benchmark

Baseline was measured before edits on the current working tree; it already contained the preceding segment/index changes. The same 1,000-document, 100-sample, Node v24.18.0, Linux x64, memory-only lifecycle benchmark was run after the changes. Times below are milliseconds; read and update values are p50.

| Operation | Baseline | Final | Change |
| --- | ---: | ---: | ---: |
| Create batch | 248.37 | 258.16 | +3.9% |
| Index flush | 2,600.45 | 2,557.67 | -1.6% |
| UUID read | 0.090 | 0.093 | +3.7% |
| Equality read | 1.511 | 1.528 | +1.1% |
| Nested-path read | 0.937 | 0.950 | +1.4% |
| Range read | 4.269 | 4.205 | -1.5% |
| UUID update | 0.308 | 0.331 | +7.5% |
| Delete 25 records | 8.20 | 7.78 | -5.1% |
| Peak RSS | 117,580 KiB | 113,824 KiB | -3.2% |

CPU utilization was 124% before and 125% after on a 2-vCPU host. These small timing differences are within normal run-to-run variation; this pass centralizes behavior rather than targeting a speedup. Raw runs and p95/p99 values are retained in the paired JSON files.

## Validation

- 2 DB property/path tests passed, covering container and array indexing plus dotted-path reconstruction.
- 6 focused lifecycle/query/index tests passed, covering scope lifecycle, persistence reopen, complex dotted filters, ordered duplicate/range scans, and catalog statistics.
- 3 shared utility tests passed, including unchanged default output and the new opt-in semantics.
- The broader `operators.test.js` / `query.test.js` run was not clean. It includes failures around older CRUD and UUID/layout expectations already present in the current working tree; those failures were not established as regressions by a pre-change test run.

## Artifacts

- Baseline: `baseline-dot-notation-2026-11-19.json`
- Final: `final-dot-notation-2026-11-19.json`
