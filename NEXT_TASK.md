# CoCreateDB — Specification Alignment Tasks

The specifications under [`specifications/`](specifications/README.md) define
the target contracts. Implementation tasks below bring the code, public names,
tests, and documentation into line with those contracts. These are implementation
targets; a spec describing a behavior does not mean that behavior is implemented.

## How to complete each alignment task

For each workstream:

1. Map each relevant specification rule to the current source path and public
   method/function name.
2. Record the concrete code gap before changing it. Keep names consistent across
   the method envelope, implementation, persisted artifact, and documentation.
3. Implement only the behavior owned by that specification. Cross-cutting rules
   should link to their authoritative specification rather than be copied.
4. Add or update focused tests for the stated contract, including failure and
   boundary cases.
5. Update the specification only if implementation work exposes a real open
   decision; do not weaken a settled rule merely to fit existing code.
6. Report changed paths, test results, remaining gaps, and any compatibility or
   migration effects.

Use [`specifications/edge-cases.md`](specifications/edge-cases.md) to track
cross-layer scenarios and their resolution status. Keep implementation actions in
the owning workstream below and link back to the edge-case entry rather than
duplicating its analysis.

## Current implementation gaps confirmed from source

- Field indexes still use value-type branches; the target is one schemaless
  ordered index per field path. See [indexes.md](specifications/indexes.md).
- Mutation application has creation-time stale-generation/deletion-marker
  checks, but timestamp-based convergence by `updated.on` is not implemented as
  specified. See [reconciliation.md](specifications/reconciliation.md).
- Object update replies include the resulting object and `$update`; peer updates
  carry patches, while create/delete peer delivery still includes full records.
  See [replication.md](specifications/replication.md) and
  [crud.md](specifications/crud.md).
- Scope/method routing already dispatches `<scope>.<operation>` for storage,
  database, array, index, and object. The physical layout still uses the current
  `root.json` and record paths rather than the proposed `index.json`, `indexes/`,
  `distribution/`, and `data/` organization. See
  [scopes.md](specifications/scopes.md),
  [root-index specification](specifications/README.md),
  and [architecture.md](specifications/architecture.md).
- Local persistence, write-behind, peer delivery, and external persistence are
  separate paths today, and `writeBehind` currently selects different response
  timing. External workflow writes remain disabled. The target is unconditional
  response-first behavior with asynchronous backend work; align and decouple
  these paths to that contract.

## Workstreams

### 1. Schemaless indexes and query planning

Authoritative contract: [indexes.md](specifications/indexes.md).

- Replace per-type index branches with one logical index per indexed field path.
- Preserve stored values as supplied; do not normalize them by field or apparent
  type. Keep equality and relational query semantics in the shared operators.
- Define a deterministic ordering suitable for the tree while preserving query
  results. JavaScript relational comparison is not a total order over arbitrary
  mixed values; use broad candidate scans and operator verification wherever
  pruning cannot be proven safe.
- Keep each node's actual first/last value boundaries and order chunks by those
  boundaries, not by filenames or IDs.
- Keep date conversion out of DB indexing: callers provide UTC ISO date strings
  when they need chronological string sorting.
- Align index creation, updates, deletes, nested-field extraction, query
  candidate planning, sorting, README examples, and index function names with the
  spec. Do not add type-specific index configuration as part of this work.
- Cover mixed-value equality/range queries, missing values, nested values,
  boundary pruning, sorting, and chunk split/reopen behavior.

### 2. CRUD operations, scopes, and naming

Authoritative contracts: [crud.md](specifications/crud.md) and
[scopes.md](specifications/scopes.md).

- Preserve the method convention `<scope>.<operation>`: the prefix chooses the
  handler and the suffix chooses `create`, `read`, `update`, or `delete`.
- Align object, array, database, storage, and index behavior with the CRUD spec;
  keep `key` as a value/path inside an object unless a future contract adds a
  separate key method.
- Document request and response properties, identity handling, filters, sort,
  pagination, projection, upsert, no-match behavior, and errors at the correct
  scope. Resolve the currently open no-match/update response contract.
- Keep query and update operators delegated to the shared Utils semantics. Make
  the supported operator list and examples consistent with that source of truth.
- Align public function and method names such as index operations and persistence
  operations with the nouns and verbs used in the specs. Avoid duplicate aliases
  unless compatibility requires them.
- Implement and verify the namespace/path convention in
  [scopes.md](specifications/scopes.md): every payload supplies an immutable
  `organization_id` namespace scope that creates the main entry point under the
  configured base. It addresses all child scopes but is not itself a CRUD method
  target. Initialize the organization root on first use.
- Move physical path configuration into the selected persistence workflow. For
  the filesystem workflow, keep the rule that its configured base path contains
  `<organization_id>/`, relative paths resolve from CWD, and an unset path means
  CWD; do not add an implicit `CoCreateDB` folder. Verify `.`, `../`,
  `../CoCreateDB`, `../organizations`, and `../clusterdb` through that workflow.

### 3. Mutation processing and timestamp reconciliation

Authoritative contracts: [mutations.md](specifications/mutations.md) and
[reconciliation.md](specifications/reconciliation.md).

- Implement `updated.on` as the mutation timestamp used for Newer Mutation Wins;
  preserve the original time and mutation identity through peer processing.
- Define deterministic equal-timestamp ordering and enough per-change ordering
  metadata to reconcile independent field changes.
- Apply accepted operators to the selected current state in one mutation path,
  returning the resulting object and update object. Preserve relative operator
  intent such as `$inc`.
- Implement consistent create/update/upsert/delete ordering, including missing
  documents, deleted documents, delayed upserts, and newer recreation.
- Make duplicate delivery idempotent, including relative operators.
- Remove or replace current creation-time stale-generation behavior only as part
  of implementing the specified timestamp reconciliation and deletion-order
  guarantees. Temporary markers alone do not provide a durable deletion-order
  guarantee.
- Cover same-field conflicts, independent fields, equal timestamps, duplicate
  operations, delete/upsert races, and ordered CRUD sequences.

### 4. Client and peer propagation

Authoritative contract: [replication.md](specifications/replication.md).

- Return resulting object state plus the corresponding update object to clients
  for mutations; include explicit deletion state for deletes.
- The client response is the primary outcome: send it immediately once the
  in-memory result is ready. Do not make response speed or completion depend on
  a survivability flag, a peer, or any storage layer.
- Send peers the operation-tagged update object with addressing, original
  timestamp/identity, and reconciliation metadata, not the resulting full object.
- Start peer propagation immediately in the same response cycle, back-to-back
  with initiating the client response; these are adjacent/concurrent effects,
  not a serial wait chain. Prioritize the client response, and never wait for
  peer receipt, application, or acknowledgment before returning it.
- Ensure receiving nodes reconcile and apply the update without accidentally
  re-originating it. Preserve enough metadata for the same decision downstream.
- Define duplicate handling and recovery separately from transport success.
- Cover create, update, delete, delayed delivery, missing bases, duplicate
  delivery, and prompt client response handoff without waiting for acknowledgment.

### 5. Root index, data layout, and storage naming

Authoritative contracts: [root-index specification](specifications/README.md),
[architecture.md](specifications/architecture.md), and
[data.md](specifications/data.md).

- Implement the specified `index.json` manifest with informational package
  `version` and a generic `root` reference to the top index node. Do not add a
  `format` field or reject a database because its recorded package version
  differs from the running package.
- Provide a static CoCreateDB version constant in source/built artifacts and a
  build or release script that synchronizes and validates it against
  `package.json`. Runtime manifest creation must not read `package.json`.
- Ensure the top index node makes all scopes reachable from the organization
  namespace; `storages` is the first scope catalog, not the namespace root.
- Move index nodes under `indexes/`, distribution records under `distribution/`,
  and stored scope artifacts under `data/` according to the target structure.
- Define how the `data/` layout represents storage/database/array/object/key
  scopes and document key-value data without confusing data objects with index
  nodes or distribution metadata.
- Align path construction, serializers, cache addresses, bootstrap checks,
  fixtures, and peer artifact references with the same vocabulary.
- Create and document a compatibility/migration path from existing `root.json`
  and current record directories. Do not rewrite existing datasets implicitly.

### 6. Distribution and artifact discovery

Authoritative contract: [distribution.md](specifications/distribution.md).

- Define the distribution record shape and stable artifact/partition addressing.
- Align holder updates, inventory exchange, peer lookup/acquisition, and stale
  holder cleanup with the distinction between distribution metadata, indexes,
  and data payloads.
- Preserve the rule that an advertised but unavailable artifact is an acquisition
  failure, not an empty index or silently missing document.
- Decide how distribution state is rebuilt after restart and how large inventories
  are batched. Do not persist peer inventories unless the distribution contract
  requires it.

### 7. Response-first execution and asynchronous persistence

Authoritative contracts: [crud.md](specifications/crud.md),
[replication.md](specifications/replication.md), and
[persistence.md](specifications/persistence.md).

- Make response-first execution an invariant, not a `writeBehind` option. Once
  requested data is ready in memory and CRUD has produced the result, return it
  without waiting for the persistence workflow, indexing follow-up, peer
  delivery, or acknowledgments from any node.
- Treat the client response as the top-priority immediate output. Dispatch peer
  updates back-to-back with response initiation in the same processing cycle so
  both proceed promptly; do not hold either behind disk persistence, and do not
  hold the response behind peer work. Neither path waits for the other's
  acknowledgment.
- Trace the existing index queue, delivery queue, disk queue, holds, and
  retry/error reporting. Remove the core-managed disk queue as a provider path;
  invoke the persistence workflow at the persistence cycle without making
  workflow completion a prerequisite for the CRUD response.
- Remove `writeBehind` as a response or persistence-mode switch. The
  response-first lifecycle is unconditional. `flush()` and orderly shutdown
  signal/drain pending core work and workflow invocations without defining
  provider order themselves.
- Keep mutation acceptance/reconciliation and construction of the resulting
  object/update object in the request path. Apply the mutation exactly once;
  background persistence serializes the resulting state rather than reapplying
  operators.
- Keep index maintenance, peer propagation, and persistence as separately
  observable background effects. Preserve read correctness while indexing is
  pending by verifying candidate documents against the current in-memory values.
- Ensure background failures do not retroactively change a completed response.
  Expose errors/retry state independently and define restart recovery separately.
- State clearly that the CRUD response acknowledges the in-memory result, not
  crash-durable disk state or peer application. Client IndexedDB persistence and
  recovery are an independent layer and do not delay the DB response. If the
  client receives and persists the result, it retains its own copy; delivery or
  client-side persistence guarantees are separate from the DB response contract.
- Route every durable read/write/delete for documents, indexes, root/catalog
  metadata, and other DB artifacts exclusively through the configured
  persistence workflow. Remove direct filesystem persistence helpers from the
  core and do not retain a local-filesystem fallback.
- Remove independent disk/file persistence configuration and execution paths,
  including `disk`, `file`, `memoryOnly`-as-a-persistence-bypass, and equivalent
  settings. Keep any in-memory working-set policy separate from persistence
  destination selection.
- Move filesystem base-path configuration and `COCREATE_DB_DIRECTORY` handling
  into the filesystem workflow. The core passes organization namespace and
  artifact identity; workflow configuration resolves physical destinations.
- Define and implement the workflow invocation envelope and behavior when no
  persistence workflow is configured. Do not silently fall back to direct disk.
- Let workflow configuration define provider combination, order, concurrency,
  retries, encryption, and provider-specific behavior. The core must not impose a
  sequential disk write order over workflow-controlled provider operations.
- Ensure workflow failures are observable/recoverable independently of completed
  CRUD responses; do not introduce peer or storage acknowledgments into that
  response path. Preserve explicit durability boundaries and document crash and
  multi-artifact recovery behavior.

### 8. Primary/worker workload offloading

Investigate whether CoCreateDB can move selected CPU or I/O work from the primary
process to workers while keeping the primary responsive for database requests.
This is an evaluation task; do not change the process or ownership model until
the measurements and consistency constraints are understood.

- Trace the current request path from a worker's `DB.send` call through IPC to
  the primary-owned DB engine and back. Record which operations already run in
  workers, which state is owned only by the primary, and the IPC payload and
  response costs.
- Profile representative read, create, update, and delete workloads to identify
  primary CPU time, serialization and IPC overhead, index maintenance,
  distribution work, and persistence work. Establish whether persistence or
  mutation processing is a meaningful primary bottleneck before designing an
  offload path.
- Evaluate sending immutable, already-resolved persistence work from the primary
  to a worker-side persistence executor. Keep the primary's mutation result and
  response-first client path independent of persistence completion. Route all
  durable I/O through the configured persistence workflow; do not reintroduce a
  core-owned disk path.
- Evaluate which preparation work can safely run outside the primary, such as
  serialization, encoding, or constructing distribution/persistence envelopes.
  Do not move authoritative index or in-memory document mutation without a
  design for ownership, ordering, and concurrent access to that state.
- Evaluate reconciliation and update-object construction separately. Preserve
  the authoritative mutation order and reconciliation decision for each
  document; a worker may assist only if requests for the same document remain
  serialized and duplicate or delayed work cannot apply twice or overwrite a
  newer result.
- Define the worker execution contract: task identity, input snapshot/version,
  completion or failure reporting, retry and duplicate behavior, queue limits,
  shutdown/drain behavior, and handling of worker loss. Do not wait for worker
  acknowledgments before returning CRUD results to clients or dispatching peer
  updates.
- Compare using existing request workers with a dedicated persistence/compute
  worker pool. Account for contention with user workloads, IPC transfer costs,
  memory copies, backpressure, and whether offloading increases total throughput
  rather than only shifting load.
- Retain primary ownership of in-memory DB state and distribution decisions
  unless measurements and a separate ownership design justify changing it.
  Document which operations remain primary-owned and which are eligible to move.
- Add benchmarks and focused correctness tests only after choosing an offload
  boundary. Compare latency and throughput with offloading disabled and enabled,
  including worker saturation, persistence delay/failure, concurrent mutations,
  and worker restart.

This workstream depends on the response-first and workflow-owned persistence
contracts in this section. Reconciliation behavior is defined by
[`reconciliation.md`](specifications/reconciliation.md), and peer ownership and
delivery by [`replication.md`](specifications/replication.md).

## Remaining design decisions

These details are not settled by the higher-level conventions and should be
resolved within the owning specification before implementation depends on them:

- Total deterministic index ordering for mixed and non-finite values, and when
  the planner must fall back to a full candidate scan.
- Exact per-field version metadata and equal-timestamp tie-break representation.
- Durable metadata needed to prevent deleted documents from reappearing after
  marker loss or delayed replication.
- Whether uniqueness constraints are needed, and their local/distributed scope.
- Durable retry/replay, replica acknowledgments, multi-file atomicity, and
  recovery guarantees.
- Behavior when no persistence workflow is configured, and the workflow
  invocation/result envelope.
- Exact `data/` encoding and top-index-node schema.

## Existing checks and compatibility notes

Known checks in `test/write-behind.test.js` still need reconciliation with the
current contracts: failed-indexing rollback, sequential persistence assumptions,
deletion-marker paths, and workflow acknowledgment while external writes remain
disabled. These test expectations should be updated with the owning workstream;
do not treat an old assertion as the specification.

The entity-holder directory currently supports metadata and exact-object
acquisition. Retain it until the distribution/index-trail work defines and
implements a replacement. Existing deployments use `root.json` and current
record paths until the layout migration is designed and performed.

## Constraints

Read `AGENTS.md` and `ARCHITECTURE.md` before changing the engine. Preserve scoped
identities, complete acquired documents, shared query/update semantics, reference
ownership, and unrelated workspace changes. Use targeted peer reads with
timeouts. Report changed paths, tests run, gaps, and compatibility effects.
