# CoCreateDB — live artifact prototype

Experimental branch integration snapshot, not a production replacement.

## Scope and artifact model

`createDB(server, { config, scopes, version, size })` accepts a configurable
scope hierarchy. By default it uses `$organization_id → storage → database →
array → object/index`. The active hierarchy is the ordinary mutable object at
`db.scopes`; `db.config` retains the associated version and scope reference.
Only `$organization_id` is dynamic and it resolves from the CRUD envelope.

The primary owns one flat `db.artifacts` Map, keyed by artifact UUID, and one
shared `db.tree` catalog. Scope resolution follows the configured hierarchy,
acquires or creates the required parent artifacts, and passes their live
references into the normal CRUD path. Every non-root artifact stores its
immediate parent UUID in `scope`. `scopeType` identifies which configured
branch an artifact belongs to when siblings such as `object` and `index` share
a parent. Both fields are indexed and immutable through artifact updates.
Deleting an artifact with children is rejected to avoid leaving orphaned
relationships.

All artifact kinds use the same artifact and `Tree` primitives. The tree code
does not inspect scope names or hierarchy; the scope manager supplies the
parent and branch constraints. Configuration edits affect later resolution but
do not migrate or delete existing artifacts. Reads never create missing scope
artifacts. Create and upsert may create missing parents.

This prototype's distribution locator and persistence provider are still
scaffolds, so scope acquisition currently resolves from local memory only.
Peer and persistence fallback need their existing artifact-acquisition
contracts to be integrated; this scope change does not invent a second one.

The deterministic 1,000-object lifecycle run before and after scope resolution
used fixture v2 and Node 24.18. Create plus index rose from 174.93 ms to an
average 208.65 ms (5,717 to 4,793 records/s). Across two after runs, UUID read
p50 averaged 0.124 ms (baseline 0.009 ms); equality 0.335 ms (0.183 ms); nested
0.215 ms (0.136 ms); range 0.555 ms (0.280 ms); update 0.199 ms (0.127 ms).
The 25-item delete batch averaged 2.57 ms versus 1.94 ms. Post-run heap used
averaged 19.18 MB versus 10.86 MB; RSS averaged 85.99 MB versus 78.49 MB. CPU
time rose from 337 ms to an average 473 ms. The additional scope and parent
indexes have a measurable cost, and each operation resolves its configured
ancestors. UUID reads are the largest relative regression and merit a follow-up
optimization before treating this performance profile as settled. Raw runs are
in `/tmp/db-scopes-before`, `/tmp/db-scopes-after-final`, and
`/tmp/db-scopes-after-repeat` for this environment.

## Structure

- `src/index.js`: factory, server scope and native send entry point.
- `src/artifact.js`: live object identity and index entries.
- `src/tree/index.js`, `src/tree/query.js`: runtime grouped partitions and selection.
- `src/crud/index.js`: CRUD orchestration for configured scopes.
- `src/distribution/index.js`, `src/distribution/peers.js`: scaffolds only.
- `src/persistence.js`: no-op provider.

## Integration boundaries

The default factory accepts `createDB(server, { config, scopes, persistence, forward, size })`.
Primary detection uses `server.isPrimary`; the worker uses an injected `forward(request)` function. No production IPC or Socket Server protocol is invented here. Adapt the factory to the existing server contract on the integration branch. Distribution does not yet implement peer messages, inventory, acquisition or propagation; CRUD does not yet resolve missing artifacts via peers or persistence. Keep existing production behavior until these are integrated.

The exported package uses the normal `@cocreate/utils` dependency; the prototype
does not include a local copy of shared utilities.

Configured scopes now share CRUD dispatch, but query semantics remain limited;
sorting/search, persistence hydration, production authorization, and peer
acquisition require further integration. `updateArtifact` still clones and
reconciles fields; timestamp/conflict handling and several nested/array
mutation cases remain to be audited. Local benchmarks bypass production server,
distribution, and durable persistence costs.

## Tests and cross-version comparison

Run the active prototype suite:

```sh
npm test
```

It tests the actual installed `@cocreate/utils` package. The previous
implementation's tests are kept under `test/legacy/` as references, not run
against this prototype.

Old and new versions share deterministic lifecycle fixture v2, UUIDs, object fields, and
UUID/equality/nested/range queries. To run both versions and retain raw JSON plus
a Markdown comparison report:

```sh
BENCH_SAMPLES=40 test/benchmarks/compare-lifecycle.sh 1000
```

The script uses `dev` as the old source by default (`OLD_REF` can select another
ref), creates a temporary worktree, and stores comparison output under
`test/benchmarks/comparisons/`. It reports cold first reads/updates immediately
after creating a fresh record, warm percentiles and operations per second,
create-and-index throughput, CPU, and memory. Keep dataset size, Node version,
sample count, and host conditions matched. The report also records index-entry
coverage, which currently differs between implementations, so the timing
comparison is not mistaken for equal indexing work. Both runs are memory-only;
they exclude durable storage, peers, and external persistence.
