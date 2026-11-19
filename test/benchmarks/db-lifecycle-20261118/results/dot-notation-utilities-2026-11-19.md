# CoCreateDB shared dot notation utilities — 2026-11-19

## Changes

CoCreateDB consumes the existing `objectToDotNotation(object)` API to produce flattened leaf paths. It iterates those paths and performs its own index bookkeeping, including existence entries and container values needed by array and object operators. Dotted path strings remain intact as index keys. `normalizeObject()` uses the existing `dotNotationToObject()` utility for dotted and bracketed request fields after CoCreateDB's current metadata filtering and path validation.

The `@cocreate/utils` utility implementation and API are unchanged. CoCreateDB preserves nested document storage, existing query planning, candidate selection, segment traversal, and direct application of synchronized index artifacts.

## Benchmark

Baseline was measured before edits on the current working tree; it already contained the preceding segment/index changes. The same 1,000-document, 100-sample, Node v24.18.0, Linux x64, memory-only lifecycle benchmark was run after the changes. Times below are milliseconds; read and update values are p50.

| Operation | Baseline | Final | Change |
| --- | ---: | ---: | ---: |
| Create batch | 248.37 | 261.38 | +5.2% |
| Index flush | 2,600.45 | 2,701.28 | +3.9% |
| UUID read | 0.090 | 0.090 | +0.3% |
| Equality read | 1.511 | 1.515 | +0.3% |
| Nested-path read | 0.937 | 0.953 | +1.7% |
| Range read | 4.269 | 4.151 | -2.8% |
| UUID update | 0.308 | 0.366 | +18.7% |
| Delete 25 records | 8.20 | 6.29 | -23.2% |
| Peak RSS | 117,580 KiB | 117,796 KiB | +0.2% |

CPU utilization was 124% before and 125% after on a 2-vCPU host. Most read and indexing differences are small; the UUID update p50 was higher in this run and should be rechecked before drawing a performance conclusion. This pass targets consistent utility use and reduced duplicate flattening logic, not a speedup.

## Validation

- 2 DB property/path tests passed, covering nested and array indexes plus dotted-path reconstruction.
- 7 focused lifecycle/query/index tests passed, covering scope lifecycle, persistence reopen, complex dotted filters, ordered duplicate/range scans, and catalog statistics.
- The broader operators/query test files still have failures tied to older CRUD and UUID/layout expectations in the current working tree; they were not established as regressions by a pre-change test run.

## Artifacts

- Baseline: `baseline-dot-notation-2026-11-19.json`
- Final: `final-dot-notation-2026-11-19.json`
- Final raw run: `run-2026-11-19T03-59-32.383Z.json`
