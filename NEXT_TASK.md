# CoCreateDB — Unified Data Architecture and Implementation Tasks

> Task revision: v0.5 · 2026-11-17
> Repository: `CoCreateJS/db` · Package: `@cocreate/db`
> Previous baseline: [v0.4](NEXT_TASK-v0.4.md) · [NEXT_TASK-v0.3.md](NEXT_TASK-v0.3.md) · [v0.2](NEXT_TASK-v0.2.md) · [v0.1](NEXT_TASK-v0.1.md)

## Objective

Converge the existing CoCreateDB implementation on a unified, storage-independent JavaScript value architecture: complete application objects, deeply traversable indexes, independently addressable index segments, flat extensionless UUID persistence, a shared lossless serialization standard, and demand-driven distribution.

This is an incremental refactor, not a replacement engine. Reuse the existing indexing primitive, CRUD dispatcher, shared operators, mutation pipeline, holder discovery, cache, primary/worker integration and tests wherever compatible. Remove redundant physical representations once their replacement is verified. Existing persisted datasets are disposable for this development transition; the target database will be initialized cleanly. No legacy data migration or backward-compatible persistence reader is required.

## 1. Implementation authority and review

Read `AGENTS.md`, root `ARCHITECTURE.md`, this task and every file in `specifications/` before editing. Root architecture describes implemented behavior; specifications describe the previous target. This task records the newly agreed target and supersedes conflicting prior target rules (particularly physical layout, key artifacts, serialization, and bootstrap ownership). Other specification contracts remain applicable. `WHITEPAPER.md` is conceptual context, not executable requirements.

- Map existing source, exports, tests, queues, paths, cache keys and peer messages to the workstreams below. Confirm prior reported gaps against the actual checkout; do not assume they remain unchanged.
- Identify reusable code and propose small dependency-ordered changes. Preserve unrelated workspace edits and public names wherever possible.
- Resolve the open contracts in section 13 before implementing behavior that depends on them. Do not invent incompatible public APIs or weaken invariants to pass legacy tests.
- Keep a workstream checklist, record source paths and focused tests, and report clean initialization requirements. Align owning specifications when separately authorized; update root architecture only to reflect validated implementation. Do not rewrite the whitepaper as part of this task.

## 2. Target architecture and addressing

```text
<organization_id>/
  index.json
  data/
    <uuid>
    <uuid>
    ...
  distribution/
    <local operational metadata>
```

- `organization_id` is an immutable, caller-supplied top-level operation payload property, alongside `storage`, `database`, `array`, and `object`. It selects the tenancy namespace per operation; it is not a CRUD target, nested object property, or instance-wide configuration. Validate the authorized organization context before resolving its bootstrap or accessing artifacts. Scope isolation applies to memory, persistence, discovery and peer messages.
- Example payload (method-specific fields omitted): `{"organization_id":"<id>","storage":"<storage>","database":"<database>","array":"<array>","object":{}}`.
- `index.json` is the externally provisioned bootstrap entry point. `data/` contains all database-owned durable artifacts: scope catalogs, index roots and segments, complete objects, and durable reconciliation metadata. No separate `indexes/`, `objects/`, `keys/`, or `deleted/` trees in the target namespace.
- `distribution/` retains the existing local distribution implementation and manages distribution state for files held on the local disk. It is never persisted to cloud storage by the DB. Its lifecycle and ownership must be explicit (section 10).
- Only `data/` is eligible for database-managed cloud persistence. Every database-managed UUID artifact resides under `data/`; `distribution/` and the required external `index.json` are excluded from database cloud persistence and artifact export.
- Each data artifact has an opaque randomly generated UUID, with no extension or semantic path. Preserve its address across ordinary updates; allocate a new address only for a new artifact, including index splits. Never reuse a deleted identity for unrelated data. Handle collisions without overwrite. Logical object IDs (`_id`) remain distinct from artifact UUIDs.
- Canonical terms are **organization, scope, index, artifact**. `index.json` is only bootstrap configuration: its `root` field points to the first index artifact; root is not a scope or data layer. An index resolves to a child index or the artifact holding the addressed scope value. Index artifacts hold lookup structures; scope-value artifacts hold the actual values. A complete application object is a document at the `object` scope.
- The `organization_id` value is the namespace identity; there is no namespace node above it. Scopes within it follow `storage → database → array → object`. Storage is the first scope and groups databases. Object property paths are maintained by the object index and point to the owning complete object artifact; there is no key scope or key artifact.
- Use one organization-scoped `data` Map keyed by the exact artifact UUID, holding decoded values. A stored `undefined` must not be confused with absence (`Map.has`). A registry or equivalent namespace boundary may hold multiple organization Maps. Reuse existing metadata/ownership mechanisms where needed; do not maintain duplicate authoritative object representations.
- Provider implementations may map addresses internally, but core addresses are UUIDs; no core filename extension, path inference, type-dependent directory or implicit product-named directory.

## 3. Bootstrap and scope discovery

Preserve the existing target manifest shape:

```json
{"version":"1.0.0","root":"<uuid>"}
```

- `version` is informational package provenance, embedded at build time and checked against `package.json` during release, not runtime. No `format` field; no package-version equality gate. Codec compatibility is separate.
- `root` addresses the first independently persisted index artifact in `data/`. That index makes scopes reachable. Scope indexes, including the storage scope index, are distinct from the bootstrap configuration and first index artifact.
- The required manifest is resolved for the payload organization_id and is not a database-owned artifact or cloud-persisted by the DB. It is external bootstrap configuration, outside ordinary data CRUD, artifact transfer/export and persistence lifecycle. Accept a provisioned entry point through an explicit integration contract; do not require direct core filesystem access. Provisioning may use files, startup configuration or another external authority.
- Replace implicit organization first-use initialization with an explicit new-namespace provisioning handshake. Reopening an existing namespace must not silently generate a new first index when the bootstrap config or a referenced artifact is unavailable. Define config publication and independent recovery before enabling creation.
- Keep filesystem workflow base configuration relative to CWD, default CWD; test `.`, `../`, `../CoCreateDB`, `../organizations`, `../clusterdb`. Move `COCREATE_DB_DIRECTORY` handling to the workflow. The bootstrap authority must separately know how to resolve its manifest.
- Test existing/new namespace, incorrect organization, unavailable root, malformed manifest, version mismatch, and reopening from a provisioned root with an empty cache.

## 4. Unified serialization and encryption

Implement one portable codec contract (`serialize(value)` / `deserialize(bytes)`; names illustrative until shared export is confirmed). Runtime values remain decoded; all ordinary data artifacts are persisted as serialized bytes. No raw/text mode switch, native file extension or binary-specific extraction. Socket and Mesh should ultimately share the same codec/value model; do not block DB work on a complete Socket rewrite.

- Compare candidate codecs (CBOR, MessagePack or another suitable implementation) in Node and browser environments. Select only after round-trip and performance tests. Preserve nested objects/arrays, strings, booleans, null, explicit undefined versus missing, finite and non-finite numbers including NaN/Infinity, and native binary bytes. Define BigInt, typed arrays, Buffer/Uint8Array/ArrayBuffer normalization, Date, sparse arrays, Map/Set and cyclic/shared references explicitly; do not promise unsupported types or JS reference identity across process boundaries.
- Preserve the existing UTC ISO string date convention for ordered queries; never infer or evaluate date expressions. Reject unsupported values explicitly. No executable persisted values, eval, dynamic import or arbitrary constructor execution. Validate decoding limits and hostile inputs.
- Define codec compatibility independently of the bootstrap package version; use a documented encoding/envelope or external format contract for the new format and its future evolution; no previous-format reader is required. Avoid per-file extension detection. Measure encoded size, serialization and deserialization CPU, allocation and representative binary workloads.
- Persistence write pipeline: obtain stable resulting value → serialize → optionally encrypt → workflow provider writes bytes. Read: acquire bytes → decrypt if required → deserialize → validate and publish decoded value. Define the exact codec/encryption ownership at the workflow boundary so bytes are not encoded twice. Encryption policy and key selection belong to the workflow; use authenticated encryption, versioned key references, and rotation/recovery support. Do not store the key with ciphertext. Indexes and metadata may contain sensitive values too.
- Keep transport security independent of at-rest encryption. Existing Socket JSON behavior is an integration gap for extended values; coordinate deployment of the new codec and explicitly report unsupported paths until shared codec integration works end to end. No Base64 as the default transport of binary fields, no separate attachment protocol for ordinary values.
- Large object streaming/chunk transport is a separate evaluated task; do not mistake index segmentation for binary streaming. Measure and bound memory and message sizes. A small update to a large complete object may rewrite the full artifact; do not introduce implicit data fragmentation to hide that limitation.

## 5. Complete objects and property paths

- Persist one complete application object per object UUID, including nested objects, arrays and supported binary values. An object's `_id` identifies it logically; indexes resolve to its physical UUID. The UUID remains stable throughout ordinary mutations.
- Property paths describe values within objects and live in the object index. Do not create key scopes, UUIDs, or per-key artifacts. Retain nested path extraction and query logic. Index entries and segments are independent artifacts.
- For example, `settings.appearance.theme = "dark"` and individual members of `permissions` can be indexed. Every path entry points to the whole owning object artifact. Binary views are atomic values for traversal unless an explicit operator contract says otherwise; never enumerate bytes as nested keys by accident.
- Reads acquire the complete object, apply filters and projection in memory, and preserve supported value types. Updates apply to logical paths using shared operators and persist the resulting whole object. Deletes remove the object and relevant index entries and retain necessary reconciliation state through the workflow.
- Test nested objects, arrays of objects, binary-containing objects, missing/undefined, projections and nested updates. Verify property lookup and index reconciliation against the complete object artifact and preserve UUIDs through ordinary mutations.

## 6. Schemaless indexes and query planning

Baseline: `specifications/indexes.md`. Preserve the independently usable indexing primitive and recursive ordered tree algorithm.

- One logical index per indexed key path; replace type-specific branches. Preserve supplied values; no schema coercion. Missing keys have no value entry; explicit undefined requires defined semantics.
- Traverse deeply nested objects and arrays for query/index purposes. Define dot-path escaping, array membership, array-of-object traversal, duplicate membership and positional correlation. Index references identify the artifact for the addressed scope; object-scope references identify complete document artifacts. Use logical identity/UUID as stable tie-breaker and deduplicate artifact candidates.
- Define deterministic mixed-value tree ordering and count semantics (entries versus distinct objects), including NaN, undefined, composite values and binary indexing policy. Preserve true first/last boundaries and child counts. Keep shared operator semantics authoritative; use broad scans and final verification whenever pruning is unsafe. Do not silently omit unsupported values from candidate plans.
- Reuse recursive split/prune/index-tree-root-collapse logic and lazy forward/reverse traversal. Measure actual encoded bytes for split thresholds, retain one existing address on split and allocate the required sibling/index-tree-root addresses. Handle an unsplittable large entry explicitly. Maintain ancestor metadata on inserts/deletes and do not infer ordering from filenames.
- Preserve `_id` enumeration, sorting, pagination, candidate-length planning, AND/OR and fallback scans. Verify correlated array predicates against the complete object; independent index matches must not imply same-element matches. Confirm membership operator names against Utils (do not assume `$includes` exists).
- Preserve query correctness during pending index work: merge relevant pending additions/changes into candidates, exclude deletions, then verify current object state. Verification alone cannot recover omitted candidates. Use generation/version checks so delayed index results do not overwrite newer state.
- Tests: mixed types and bounds, duplicates, nested paths and arrays, correlated elements, null/missing/undefined, encoded-size splits, metadata, deletion/pruning, reverse scans, empty-cache restart, narrow acquisition, and randomized comparison against a reference scan.

## 7. CRUD, scopes and shared operators

Baseline: `specifications/crud.md`, `scopes.md`, `mutations.md`.

- Retain `<scope>.<operation>` routing for storage, database, array, object and index with create/read/update/delete. No organization or key CRUD prefix. Preserve scope envelopes (including top-level `organization_id`), immutable identities, resulting target property and explicit `success: false` errors.
- Preserve object creation with one or multiple objects, automatic logical IDs and audit fields; read by ID/filter with sort/search/pagination/projection; update with existing `$update` or generated operator patch; explicit upsert; deletion state. Preserve immutable creation metadata and original mutation timestamps.
- Reuse shared `@cocreate/utils` query/update operators; audit JSON clones, stringification, update helpers, equality and projection for extended values. Do not create competing operator implementations. Review executable query operators such as `$where` against authorization and safe-value boundaries; serialization does not grant permission to execute code.
- Resolve no-match update responses, non-object scope CRUD lifecycle, uniqueness, and authorization with existing contracts. Scope deletion must not orphan reachable artifacts or remove unrelated scopes. Public index operations remain distinct from application object mutations.
- Test top-level organization_id routing, missing/unauthorized scope, isolation across organizations with identical logical names and UUIDs, method routing, query/update compatibility, batch operations, no-match/upsert, explicit errors, and read after pending mutations.

## 8. Mutation processing and reconciliation

Baseline: `specifications/mutations.md`, `reconciliation.md`, `edge-cases.md`.

- Keep one authoritative accepted mutation path producing complete resulting object state and operation-tagged update object. Reuse incoming update intent; do not reapply operators during persistence.
- Implement Newer Mutation Wins using original `updated.on`, stable mutation identity, deterministic equal-time ordering and sufficient per-change metadata to preserve independent key updates. Define parent/child path and array conflict semantics and clock assumptions. Timestamp alone is not proof of convergence.
- Resolve relative operator ordering and deduplication (`$inc`, array updates) so duplicates/reordering do not silently change outcomes. Preserve intent and original identity through forwarding. Specify retention/replay requirements before claiming convergence.
- Define create, update, upsert, delete and newer recreation ordering across missing objects and delayed mutations. Persist deletion-order metadata through the same data namespace/workflow; do not rely solely on expiring memory markers. Replace legacy creation-time guards only after tests prove replacement behavior. Define logical identity to physical UUID agreement for competing creates/recreation and replicas.
- Test independent and same-key mutations, parent/child conflicts, ties, duplicate relative operations, out-of-order delivery, delete/upsert races, restart and delayed replay.

## 9. Response-first execution and workflow persistence

Baseline: `specifications/persistence.md`, `crud.md`, `replication.md`.

- After required data acquisition and accepted in-memory mutation/result construction, initiate the client response immediately. Return resulting object and `$update` (explicit deletion state for delete); reads have no update object. Initiate peer propagation back-to-back with response handoff, without awaiting either acknowledgment. Do not place serialization for persistence, index follow-up or provider work ahead of this boundary.
- Keep pending index maintenance, peer dispatch and persistence independently observable. The client response confirms in-memory processing, not durable storage, delivery or peer application. Client-side IndexedDB is independent.
- Use logical persistence operations `create(uuid, bytes)`, `read(uuid)`, `update(uuid, bytes)`, `delete(uuid)` in explicit organization context. Exact workflow envelope/result/error contract to be approved. Only UUID artifacts in `data/` may enter database cloud persistence; never send `index.json` or `distribution/` to those workflows. Core routes every durable data artifact operation through configured workflows; providers are responsible for paths, storage and execution. Bootstrap and operational inventory are explicit separate ownership boundaries, not permission for hidden core disk I/O.
- Create must protect existing UUIDs from accidental overwrite. Define stale-write protection, mutation ordering and stable snapshots so delayed serialization or provider completion cannot replace newer state. Provider order/retries/parallelism/encryption policy belong to workflow. Define read integrity, unavailable vs absent vs corrupt results and retry reporting.
- Remove `writeBehind` as a response switch; remove `disk`, `file`, `memoryOnly` persistence bypasses and implicit filesystem fallback. A cache retention policy is not a provider selection policy. Remove core-managed disk queue as independent provider path; retain necessary pending work coordination, backpressure and drain tracking.
- Define explicit behavior without a workflow (no silent local fallback). `flush()` and shutdown drain pending core work and workflow invocations according to documented guarantees; neither implies crash-atomic multi-artifact commits. Define partial provider failure, interrupted publication, durable retry/replay and recovery semantics. Never retroactively change completed responses.
- Test delayed and failing providers, response/peer dispatch timing, no workflow, write ordering, mutation snapshots, shutdown, partial failure, restart, encrypted round trip and all artifact types. Verify no direct durable I/O in the DB core.

## 10. Distribution, replication and acquisition

Baseline: `specifications/distribution.md`, `replication.md`.

- Separate mutation replication from acquisition of complete artifacts. Peers receive operation-tagged updates, scope/identity/UUID mapping as needed, original timestamp and reconciliation metadata, not redundant resulting objects. A create operation must carry enough initial values to create an object. Missing base recovery may acquire a complete artifact; do not misapply a relative update to an absent base. Prevent re-originating accepted peer mutations.
- Use demand-driven artifact acquisition: initial nodes need only bootstrap and required index paths; fetch objects/index segments when needed, retain working-set values in the organization Map. Do not mandate full database replication. Define subscription lifetime, holder promotion, eviction and missing-base recovery. Eviction is not deletion and must not remove the last required durable copy.
- Keep local holder inventory distinct from remote-peer inventory learned in memory. Use exact organization/UUID addressing, availability and revision metadata. Define authoritative holder meaning (cached vs durable), discovery, session/reconnect, inventory batching, targeted timeouts and cleanup. Retain existing holder directory until replacement supports exact acquisition and metadata discovery.
- `distribution/` contains local operational placement metadata only, managing distribution for locally held files; preserve the existing implementation where compatible and exclude this directory from cloud persistence; define its provider/owner and restart reconstruction explicitly. Do not persist remote inventories by default. Durable conflict/deletion records belong to `data/`, not placement state.
- An advertised but unavailable artifact is an acquisition failure, not an empty index or absent object. Report incomplete paths, locked and corrupt artifacts distinctly. Moving an artifact without changing UUID preserves references, provided authorized discovery, integrity and encoding compatibility remain intact. Reconnect moved segments without rewriting logical paths; never regenerate lost content silently.
- Test partial availability, targeted acquisition, moved artifacts, reconnect, stale holders, duplicate delivery, cache eviction, namespace isolation, restart and missing/deleted bases. CDN integration and advanced autoscaling/storage tiering remain future extensions, not prerequisites.

## 11. Clean initialization

- No backward compatibility with existing persisted datasets is required. Do not implement migration, legacy readers, old-to-new UUID maps, dual-format writes, or conversion of terminal key artifacts. Reuse existing engine logic, not the obsolete storage representation.
- Initialize a new organization namespace with externally provisioned bootstrap configuration, its first index artifact, and empty data and distribution state. Build scope indexes through normal CRUD operations. Keep explicit initialization distinct from reopening an existing new-format namespace.
- Validate database behavior through its CRUD interface using test fixtures. Application dataset preparation, import tooling and application-specific setup are outside the DB module’s responsibilities. Do not embed secrets in fixtures or logs.
- Use a clean target location or an explicitly authorized reset. Do not automatically delete previous datasets or silently reset an unavailable namespace. Deploy compatible new-format nodes together; isolate old nodes rather than implementing legacy peer support.
- Reconcile legacy `test/write-behind.test.js` assumptions about rollback, sequential writes, markers and disabled external workflow acknowledgments. Preserve meaningful correctness tests; replace superseded storage fixtures with new-format fixtures. Test clean initialization, CRUD creation, index completeness, query-result correctness, restart and new-node acquisition.

## 12. Primary/worker evaluation and performance

Retain primary ownership of authoritative decoded state, mutation order and distribution decisions. This workstream is evaluation first, not an authorization to change ownership.

- Trace worker `DB.send`, IPC and primary request processing. Measure read/create/update/delete, codec CPU, copies, memory, latency/throughput, pending queues and provider delay. Compare existing baseline with refactor under identical workloads. Measure cold/warm acquisition, large objects and mixed index scans; no unvalidated superiority claims.
- Evaluate offloading immutable/versioned persistence preparation, serialization or workflow execution to workers. Compare existing workers and dedicated pool; account for IPC format/value preservation, copy cost, contention and saturation.
- Define task ID, snapshot/version, ordering, retries/deduplication, failure reporting, queue bounds, worker loss and shutdown/drain before moving work. Never wait for worker completion to acknowledge a completed in-memory mutation or initiate peer propagation.
- Do not move authoritative mutation/index ownership without separate approved consistency design. Benchmark and test offload enabled/disabled only after choosing a boundary.

## 13. Open contracts to resolve before dependent implementation

The architecture above is settled; the following are deliberately not silently selected:

| Contract | Resolution required |
| --- | --- |
| Shared codec | Library, type matrix, normalization, stable bytes/versioning, compatibility and resource limits; benchmark before selection. |
| Bootstrap | Provisioning/initialization API, external authority, bootstrap-config publication/recovery, first-index schema. |
| Address identity | UUID textual form, collision handling, concurrent creation mapping and recreation lifetime. |
| Key artifacts | Whether key-scope values share document artifacts or receive independently addressed artifacts; read/update/delete ownership. |
| Workflow | Invocation/result schema, missing-workflow behavior, encryption envelope, retries, stale-write protection, durability and flush guarantees. |
| Distribution | Operational inventory owner, restart reconstruction, holder/revision schema, subscriptions and eviction policy. |
| Index semantics | Mixed total order, count meanings, array path/correlation, composite/binary indexing, absent/undefined and safe pruning. |
| Reconciliation | Tie-breaks, per-path metadata, relative operations, delete retention/replay, parent/child and array conflicts. |
| CRUD | No-match response, non-object scopes, uniqueness and authorization; shared operator compatibility. |
| Deployment | Clean namespace initialization and coordinated new-format peer deployment. |
| Recovery | Multi-artifact publication, interrupted splits, orphan cleanup, replay, durable replica acknowledgments and explicit failure guarantees. |

Propose concrete options with source evidence and test implications. Seek approval where a public contract, durability guarantee or incompatible semantic choice is needed. Continue unrelated workstreams that do not depend on an unresolved contract.

## 14. Recommended implementation sequence and completion gates

1. **Baseline:** inspect, run existing tests, map reusable logic and agree blocking contracts. Record current limitations without changing source behavior.
2. **Foundation:** select codec and verify value preservation; define scoped UUID Map, persistence boundary, external bootstrap and top catalog. Test with controlled workflow fixtures; no hidden local fallback.
3. **Data/index convergence:** persist complete objects, use direct object UUID references and flat index artifacts, implement deep query correctness and mixed-value ordering. Validate against reference scans and restart fixtures.
4. **Mutation and lifecycle:** reconcile CRUD, pending indexes, timestamp/duplicate handling, response-first execution and async workflow durability boundaries.
5. **Distribution and clean deployment:** validate targeted acquisition, patch replication, moved/missing artifacts, clean initialization and CRUD correctness. Integrate shared transport codec only where corresponding project changes are authorized; report remaining Socket/IPC gaps.
6. **Verification:** run full regression/failure tests, benchmark, evaluate worker offloading; report documented limits. Align owning docs only after approval and root architecture only after validation.

Completion checklist:

- [ ] Existing reusable modules preserved and gaps mapped to actual source/tests.
- [ ] Extensionless UUID data artifacts and organization-scoped decoded Map agree, with external bootstrap and separate distribution ownership.
- [ ] Top-level `organization_id` selects the correct tenancy per operation; only `data/` reaches cloud persistence, and neither `index.json` nor `distribution/` is uploaded by the database.
- [ ] Complete objects round-trip through one codec and optional encryption; property paths have no independent artifacts or type-specific paths.
- [ ] Deep nested and array indexes resolve to complete objects; mixed-value queries match reference semantics and pending work cannot omit candidates.
- [ ] Index splits, pruning, restart, logical identity and independent primitive exports remain correct.
- [ ] CRUD scopes, shared operators, mutation ordering, deletion and duplicate protection satisfy approved contracts.
- [ ] Response-first timing and immediate peer dispatch verified; all durable data I/O uses workflows, with explicit failure/recovery guarantees.
- [ ] On-demand distribution, holder lifecycle, incomplete-path behavior and namespace isolation verified.
- [ ] Clean initialization and CRUD correctness verified; no legacy data migration or compatibility readers; transport limitations documented.
- [ ] Report changed paths, commands/results, benchmarks, unresolved risks and separately authorized documentation changes.

## Guiding principles

**Index deeply. Persist objects whole. Segment indexes independently.**

**Keys define the depth of discovery, not the boundaries of persistence.**

**One value model. One serialization standard. One addressing convention.**

The entry point discovers the data. The data defines the database. Distribution makes the data available.
