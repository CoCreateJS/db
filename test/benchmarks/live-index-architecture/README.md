# Live object and index architecture baseline

This benchmark captures the committed CoCreateDB implementation before the live object/index refactor. It uses the existing public CRUD API and standard memory-only lifecycle. Each cardinality runs in a separate process so its memory readings do not include prior workloads.

Run all three distributions:

```sh
BENCH_SAMPLES=40 node --expose-gc test/benchmarks/live-index-architecture/benchmark.mjs 1000
```

Or run one distribution at a time:

```sh
BENCH_SAMPLES=40 node --expose-gc test/benchmarks/live-index-architecture/benchmark.mjs 1000 unique
BENCH_SAMPLES=40 node --expose-gc test/benchmarks/live-index-architecture/benchmark.mjs 1000 high
BENCH_SAMPLES=40 node --expose-gc test/benchmarks/live-index-architecture/benchmark.mjs 1000 low
```

Wrap the command in `/usr/bin/time -v` to capture process peak RSS. Results are written to `results/`. Keep Node version, dataset size, samples, and machine conditions the same for each phase.

## Committed baseline

Source commit: `eb6f63f` (`dev`, CoCreateDB only), Node v24.18.0, Linux x64, 2 CPUs, 1,000 documents per distribution, 40 timing samples. Each document has 30 index entries as measured by `flattenIndexValues()`.

| Distribution | Distinct bucket values | Matching docs | Create ack | Index flush | Equality p50 | Nested p50 | Range p50 | Peak RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Unique | 1,000 | 1 | 251.98 ms | 2,427.20 ms | 0.213 ms | 1.05 ms | 4.80 ms | 114,932 KiB |
| High cardinality | 100 | 10 | 246.78 ms | 2,429.67 ms | 0.368 ms | 0.83 ms | 4.69 ms | 118,544 KiB |
| Low cardinality | 10 | 100 | 250.33 ms | 2,490.84 ms | 1.385 ms | 0.81 ms | 5.20 ms | 114,368 KiB |

The benchmark also records UUID-read and update latency percentiles, deletion time, and post-index/post-CRUD `rss`, `heapUsed`, `heapTotal`, and external memory. The full baseline samples are in `results/`.

## Baseline correctness

- Property-path, CoSON artifact, grouped terminal entry, and replication-splitting checks passed: 11/11.
- Targeted index/query checks passed: 11/12. The known baseline failure is `test/query.test.js` “array operators and mixed dotted paths preserve shared query semantics, including negation”; `$not: {$type: 'array'}` returns candidate `5` beyond the expected `4`. Track this against later phases rather than attributing it to the refactor.
- The standard lifecycle and this benchmark assert expected result counts for UUID, equality, nested, and range reads, plus update/delete completion.

## Live object/index phases 1–3

The object initializer is independent of storage/index construction. It retains
the original object, attaches one shared prototype, and creates hidden live
entries. Index insertion reuses these entries in grouped leaves; `toJSON()`
keeps the persisted leaf representation as UUID strings. The existing planner
and binary traversal are unchanged. Query candidates can carry a direct object
reference when their terminal entry is live, with the existing artifact-load
path retained for serialized UUID-only entries.

Final run: Node v24.18.0, Linux x64, 1,000 documents, 40 samples, same dataset
generator and options as the baseline. `create ack + index flush` is shown as
well as total time because initialization now creates the live entries before
the acknowledgment; the index flush then consumes those entries.

| Distribution | Baseline ack + flush | Live ack + flush | Total change | Equality p50 | Nested p50 | Range p50 | Update p50 | Peak RSS baseline → live |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Unique | 252 + 2,427 ms | 445 + 1,799 ms | −16.2% | 0.213 → 0.213 ms | 0.947 → 0.718 ms | 4.803 → 3.875 ms | 0.432 → 0.338 ms | 114,932 → 120,296 KiB |
| High cardinality | 247 + 2,430 ms | 445 + 1,819 ms | −15.4% | 0.368 → 0.334 ms | 1.107 → 0.689 ms | 4.690 → 4.089 ms | 0.598 → 0.339 ms | 118,544 → 118,972 KiB |
| Low cardinality | 250 + 2,491 ms | 457 + 1,790 ms | −18.0% | 1.385 → 1.010 ms | 1.078 → 0.769 ms | 5.197 → 4.254 ms | 0.404 → 0.451 ms | 114,368 → 117,832 KiB |

The measured total is 15–18% lower across these workloads. Acknowledgment
latency is 76–83% higher because initialization now constructs the live entries
before responding; index flush is 25–28% faster. UUID read p50 increased by
about 18–43%, though the absolute difference is about 0.02–0.06 ms. Low-
cardinality update p50 increased 0.047 ms. Heap after indexing rose from
11.4–11.6 MiB to 16.3–16.4 MiB (about 41–43%), reflecting the retained live
entry objects; peak RSS rose 0.4–4.7%.

The raw final runs are `run-2026-11-19T15-53-46.215Z.json`,
`run-2026-11-19T15-53-52.932Z.json`, and
`run-2026-11-19T15-54-03.007Z.json`. The matching baseline files are the three
`15-24` results above.

### Validation

- Live initialization, serialization, grouped ordering, object/entry/partition
  references, splitting, lifecycle, CoSON, property paths, and replication
  split tests: 16/16 passed.
- Focused planner/range tests: 3/3 passed.
- The full query test still has the same baseline failure for
  `tags: { $not: { $type: 'array' } }`; it is not introduced by this change.
- CoCreate Utils was not modified.

The mutation API (`setValue`, key insertion/deletion, and direct-assignment
index maintenance) remains a later phase. This change refreshes entries through
the existing CRUD reconciliation path; it does not add the proposed live
mutation contract.
