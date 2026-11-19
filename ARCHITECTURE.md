# CoCreateDB Next — Prototype Architecture

The active implementation on branch `Next` is the prototype from
`modules/cocreatedb-next`. It replaces the previous source architecture; the
previous implementation's tests are retained under `test/legacy/` for reference
and are not part of the active test command.

## Runtime structure

- `src/artifact.js` attaches live identity, key entries, and scalar mutation
  methods to plain document objects.
- `src/tree/` stores ordered, grouped value-to-entry partitions and performs
  equality/range candidate selection.
- `src/crud/` implements CRUD dispatch for configured scopes and query selection.
- `src/persistence.js` is a no-op provider interface.
- `src/distribution/` is a scaffold; peer inventory and propagation are not
  implemented.
- `src/index.js` creates a primary in-memory instance or forwards worker
  requests through the injected adapter.

`src/Scope.js` resolves CRUD envelopes against the mutable hierarchy exposed
as `db.scopes`. It creates ordinary artifacts for missing parent levels on
create/upsert, then supplies the resolved parent to the shared CRUD and tree
code. The root organization artifact has no `scope`; every descendant carries
only its immediate parent UUID. `scopeType` is indexed metadata distinguishing
configured sibling branches. Index trees remain scope-agnostic and are not
modified by scope resolution.

## Prototype limits

This is a clean-slate development path, not feature parity with the previous
CoCreateDB implementation. Scope resolution currently searches local memory;
the distribution and persistence implementations are stubs, so peer acquisition
and durable hydration are not yet connected. Full query/filter semantics,
production authorization, server IPC, timestamp/conflict handling, and several
nested or array mutation cases remain to be implemented and tested. See
[README.md](README.md) for integration boundaries and benchmark notes.

Do not infer production behavior from the prototype or from archived tests. Add
coverage as each contract is decided and implemented.
