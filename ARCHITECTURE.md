# CoCreateDB — Architecture & Design Decisions

**Repository:** `CoCreateJS/db`
**npm:** `@cocreate/db`
**Product and README title:** **CoCreateDB**
**Status:** Design specification and prototype handoff, 2026-11-10

> This document captures the design discussed for CoCreateDB. **Decided** means a settled design direction; **prototype** describes the initial code produced; **proposed** means a future option or unresolved choice. Examples illustrate structure and are not all finalized public APIs.

## 1. Vision and boundaries

CoCreateDB is a lightweight, JavaScript-native, storage-agnostic NoSQL document database engine. Its distinguishing approach is to separate **logical indexing, querying, and data management** from **physical storage**. A logical `array` can consist of independently addressable JSON objects in local directories or cloud object storage. The same engine should eventually support multiple storage backends and distributed nodes without loading entire datasets into memory.

Indexing is the initial core primitive, **not** the product name or sole capability. The primitive must remain independently accessible. Additional capabilities may include object CRUD, query execution, storage adapters, AST-based orchestration, snapshots, synchronization, and replication. These are layered on rather than built into the index algorithm.

Primary goals:

- Cheap, scalable object/file persistence (e.g. S3, GCS, Azure Blob, filesystem).
- Low persistent memory footprint; avoid full-array or whole-index hydration.
- Ordered, recursive, small index nodes with direct object ID references.
- Storage-independent read/write interfaces and independently replaceable adapters.
- Familiar CoCreateJS `array`, `object`, `key`, `index` vocabulary and MongoDB-style query compatibility through the surrounding CRUD layer.
- Incremental, testable Node.js ESM implementation without heavyweight dependencies.

Not goals for the first prototype: a complete SQL engine, arbitrary JS execution in stored documents, mandatory CRDT synchronization, automatic global balancing, or full distributed transactional correctness.

## 2. Identity and terminology

| Concern | Convention |
|---|---|
| Product, documentation, README | **CoCreateDB** |
| GitHub | `CoCreateJS/db` |
| npm | `@cocreate/db` |
| Company | CoCreate |
| Wider JS project | CoCreateJS (CoCreate Client + CoCreate Server) |
| Runtime | Node.js-first, JavaScript ESM |
| Dataset | `array` |
| Data item | `object`, addressed by `objectId` |
| Property | `key`, including nested dot notation |
| Stored property content | `value` |
| Lookup structure | `index` |

These are JS-native primitives; avoid leaking database-specific terms (`collection`, `field`, `row`, `column`) into the core API. External adapters may translate them. `object` can mean the object or CRUD target; use `objectId` when an identifier must be unambiguous.

The existing CoCreate Client uses declarative `array`, `object`, `key`, `index` addressing; CoCreateDB should align rather than introduce a second vocabulary.

## 3. Data model and physical representation

A logical dataset is an `array` of objects. **It does not need to be stored as one giant JSON array.** In a file/object-store adapter, each object can be a separate JSON document named/addressed by ObjectId; the array is a logical grouping (e.g. directory/prefix). This avoids reading or rewriting multi-terabyte collection files for single-object changes.

Illustrative payload layout:

```text
databases/
  index/
    index.json               # logical database name -> stable database ID
    <opaque-id>.json
  <database-id>/
    database.json            # name and database-level configuration
    arrays/
      index/
        index.json           # logical array name -> stable array ID
        <opaque-id>.json
      <array-id>/
        array.json           # name and array-level configuration
        index/
          index.json         # field/type catalog and object count
          <opaque-id>.json
        objects/
          <object-id>.json
```

Database and array names are indexed metadata, not directory names. Their catalogs resolve names to stable 24-character ObjectIds, so renaming updates metadata without moving descendant data. Database metadata, array metadata, and stored objects all use the shared record contract: create indexes supported record values, read resolves through indexes, update reconciles old and new index values, and delete removes index entries and JSON. Metadata `created` and `updated` values use `{ on, by }`, matching object CRUD; the actor is populated from `user_id` or `clientId` when present. An array record's numeric `count` tracks its objects, while a database's `count` tracks arrays and `objectCount` tracks objects; these are ordinary indexed metadata fields maintained through record updates. Database reads compose their arrays and counts from the recursive array catalog. Metadata JSON contains a `config` object reserved for future policies such as encryption at rest; encryption behavior is not implemented.

### JSON versus executable JavaScript files — decided

The discussion considered `.js` modules with `export default { ... }`, but concluded that JSON is the better persistence representation. Importing JavaScript does not eliminate parsing/compilation, has module cache and code-execution implications, and does not avoid serializing when saving a changed snapshot. JSON is data-only, efficiently parsed, and matches the existing serialized socket transport. JavaScript mutations occur in memory; persistence serializes the resulting state. Arbitrary functions (e.g. `Date.now()`) must not run simply because a document is read.

The serialized representation of special values (dates, coordinates, ObjectIds, binary, etc.) must be specified by a codec/schema layer; do not assume raw JSON preserves every JS type. Geo/spatial queries are a future query/index extension, not a reason to execute document code.

### Object identifiers

ObjectIds are the preferred identity and default enumeration key. Timestamp-bearing ObjectIds provide a useful deterministic order that often approximates creation time; they do **not** guarantee globally strict insertion order across independently writing distributed nodes. Enforce uniqueness via identifier generation and/or write coordination, not just a timestamp assumption.

## 4. Logical addressing and index hierarchy — decided

**Entry point:** `database + array + key`. For example:

```js
await Index.get('production', 'users', 'age')
await Index.get('production', 'users', '_id')
```

When a query has no filter/sort key, use the `_id` index to enumerate objects. A field catalog for each `database + array` maps `(key, type)` pairs to index roots. The field catalog is itself a recursive ordered tree. `index.json` remains its stable root; when its serialized size exceeds `maxBytes`, its entries move into 32-character hexadecimal UUID-derived child files and the root points to those children. Further splits can add levels. Each type branch is also a recursive ordered tree of individually persisted nodes. Node IDs are internal traversal references, not the public logical address.

```text
production / users
  └── Catalog tree (index.json root)
       ├── _id ── string tree ── ordered ObjectIds
       ├── age
       │    ├── number tree ── recursive nodes ── (value, objectId) leaves
       │    └── string tree ── recursive nodes ── (value, objectId) leaves
       └── profile.location.city
            └── string tree ── recursive nodes ── (value, objectId) leaves
```

The catalog uses the same configured byte limit and recursive split strategy as field indexes. Its stable root file may contain leaf entries or child references, but stays bounded; catalog nodes share the `index/` directory and are marked with `kind: 'catalog'`.

### Node metadata

- `id`: unique opaque node ID, stable through a local split.
- `count`: number of indexed entries in the subtree (for a leaf, its entry count).
- `first`: first ordered entry boundary `{ value, objectId }`.
- `last`: last ordered entry boundary `{ value, objectId }`.
- `entries`: ordered leaf array of `[value, objectId]` tuples, **or**
- `indexes`: ordered internal array of child references, each with `id`, `first`, `last`, `count`.

These fields let a parent choose a child without downloading its descendants, skip ranges, and propagate counts/boundaries after mutations. `first` and `last` are **actual values**, not first/last letters or fixed buckets. Equal values are ordered by `objectId` as a tie-breaker.

Example:

```json
{
  "id": "node-42",
  "count": 3,
  "first": { "value": 18, "objectId": "001" },
  "last": { "value": 25, "objectId": "003" },
  "entries": [[18, "001"], [22, "002"], [25, "003"]]
}
```

An internal node uses `indexes` instead of `entries`:

```json
{
  "id": "parent-1",
  "count": 3,
  "first": { "value": 18, "objectId": "001" },
  "last": { "value": 25, "objectId": "003" },
  "indexes": [
    { "id": "node-42", "count": 3,
      "first": { "value": 18, "objectId": "001" },
      "last": { "value": 25, "objectId": "003" } }
  ]
}
```

Each field path has its own index; field names do not require custom or compound index creation. The current prototype stores finite numbers, strings, booleans, and explicit `null` values in separate type branches; numeric values use numeric comparisons. Nested object leaves use dot-notation paths, and array scalar values are indexed under their field path. Missing values have no entry. Date encoding, empty composite values, mixed-type comparison, and broader special-value semantics remain unresolved; production indexing must not silently drop unsupported values.

## 5. Insert, split, and growth — decided

### Insert

1. Resolve the array catalog and requested key's type root.
2. Use sorted `(value, objectId)` comparisons and child `last` boundaries to descend only the relevant path.
3. Insert into the leaf at its exact sorted position (binary search is appropriate).
4. Update leaf `count`, `first`, `last` and propagate changed child references/metadata upward.
5. Check the **serialized byte size** of the modified node; if under limit, finish.
6. If oversized, split that node locally and update its parent; recursively split an overflowing parent.

### Split rule

**Insert first, then split the overflowing node approximately 50/50**, preferably by serialized byte weight (entry count is a reasonable first approximation). Keep the original node ID for the left portion, allocate a new ID for the right sibling, and insert the sibling reference in the parent in sorted order. Never require reading or redistributing neighboring siblings or descendants merely to split. An internal-node split moves child **references**, not child payloads. If the root splits, create a new parent root and update the key/type root mapping.

```text
Before: Parent -> [A: 10..80] [C: 90..120]
Insert 35 into A; A exceeds maxBytes
After:  Parent -> [A: 10..40] [B: 50..80] [C: 90..120]
```

The 50/50 approach was chosen over moving only one/two overflow entries because tiny overflow siblings could proliferate and cause frequent repeated splits. A byte-balanced split provides capacity for future inserts in both nodes while retaining local write scope.

### Growth and cleanup

- Nodes can split at any depth; a parent may recursively split, including the root.
- Maintain correct `first`, `last`, `count` throughout affected ancestors.
- Delete empty nodes and remove references; collapse redundant single-child roots where safe.
- Do not require sibling redistribution or merging partially full nodes on each mutation. Optional background compaction may be added later.
- Avoid endless splitting if a single entry exceeds the byte limit; define explicit overflow/size policy.
- No fixed alphabetical ranges (`A–F`) or arbitrary per-letter partitions: boundaries reflect real ordered values.

**Design nuance:** Stable root addresses do not imply stable root node IDs; the catalog can point to a new root after a root split. The old overflowing node retains its own ID.

## 6. Read, filter, sort, and cursor behavior

The index is a compact projection of `(key value, objectId)`, **not a copy of the full document**. A query retrieves only the key/type roots needed, narrows candidates using ordered ranges, intersects/unions candidate ObjectIds for compound predicates, and fetches full objects only when required. No-index queries may require a cursor/scan of the `_id` enumeration and object payloads.

Planned query capabilities include:

- Equality, inequality, range operators (`$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`), logical operators (`$and`, `$or`), projections, sort, limit, skip/pagination.
- Forward/reverse traversal using the **same** ordered index; reverse traversal should not require a second reversed index.
- Early termination after enough matching entries for a limit; child `count` may help skip ranges for pagination.
- Dot-notation keys (e.g. `profile.location.city`) indexed as paths.
- Index-only answers for metadata operations when possible (e.g. key existence, candidate IDs, counts), with full-object hydration only when needed.

A simple full-tree `scan()` is a **prototype** operation, not a substitute for efficient range pruning and cursor APIs. The current `object.read` prototype can intersect equality candidates from independent field indexes; range-aware planning and sort behavior are future work. Indexing every supported field increases storage/write amplification; this is an intentional initial tradeoff in exchange for broad query capability, to be measured.

### Object mutations

The filesystem `send()` prototype supports create/read/update/delete for databases and arrays, plus object create/read/update/delete. Database and array names resolve through recursive name indexes to stable 24-character ObjectIds; internal index nodes use 32-character hexadecimal UUID-derived IDs. Rename updates a catalog entry and metadata while preserving the directory ID and descendant data. Database reads include each array's name and object count. Array counts live on array metadata records and database counts live on database metadata records; all are indexed and updated through the shared record contract. Deleting an array recursively removes its objects and indexes, and deleting a database recursively removes its arrays and data. Database and array update requests can merge a `config` object into metadata for future settings such as encryption policy; encryption itself is not implemented. Existing data in the previous `<database>/<array>` layout is not migrated automatically.

Object create generates/validates an ObjectId, stores the JSON object under the database/array, indexes `_id` and supported scalar field values, and converts dotted keys to nested object paths. Reads use equality and supported range indexes to narrow candidate IDs, then call shared `queryData` and `searchData` from `@cocreate/utils` to evaluate candidates. Sorting, projection, and pagination follow the shared Filter shape. Per-source count and cursor position are returned in `filter.storages`; the client owns the aggregate `filter.index`. Updates use shared `createUpdate`, compare old/new indexed values, remove stale entries (including removed keys), insert replacements, and update tree metadata. Deletes remove each object's index entries and JSON file. Empty key/type trees are pruned from the catalog. The catalog root's `count` tracks stored objects through `_id` entries and `catalogCount` tracks catalog mappings; child references' counts describe catalog entries in their subtrees. Field-index node counts describe field entries in each node/subtree. CoCreateDB retains `$set` as a convenience; other update behavior comes from the shared utility.

## 7. Index access and filesystem reference adapter

The public root is addressed **logically**, not solely by internal ID:

```js
Index.get(database, array, key = '_id')
Index.set(database, array, key, /* mutation or index — signature TBD */)
```

**Unresolved API detail:** Earlier discussions used `set` both for persisting an index root and inserting an entry; the prototype implemented entry insertion. Finalize a non-ambiguous API before declaring stable exports. Node operations can remain private (`getNode`, `setNode`, `deleteNode`) and take resolved paths/IDs. `Index.get()` should normalize/validate the returned format regardless of adapter; storage errors must not be treated as missing indexes.

The initial reference implementation uses **Node.js `fs`** and JSON files, optionally caching parsed nodes in a Map. Its path layout:

```text
<storage-root>/
  databases/
    index/                 # recursive database-name catalog
    <database-id>/
      database.json
      arrays/
        index/             # recursive array-name catalog
        <array-id>/
          array.json
          index/           # recursive field catalog and indexes
          objects/
            <object-id>.json
```

The engine begins with a logical name lookup; after finding the stable database/array ID and index root, it follows child IDs directly without re-running logical lookup for every tree node. The `get`/`set` boundary is self-contained so later implementations can use local disk, object storage, network peers, cache tiers, or multiple destinations. Path construction belongs in the adapter/resolver, **not** in recursive algorithms. Validate logical names and opaque IDs to prevent traversal.

Cache policy is separate from index correctness. Memory is a high-cost resource in CoCreate Server; avoid retaining raw JSON and parsed objects simultaneously for long periods. The current filesystem APIs do not keep an in-memory node Map by default; callers can opt in with `cache: true`. If a memory cache is enabled, it needs bounds/eviction and coherent writes before production use. A node may be modified by reference in memory, so callers must explicitly commit through the chosen mutation interface.

### Uniform object/index cache and subscription policy — decided direction

Apply one cache and subscription policy to CoCreate data, regardless of its content or intended use. Data remains addressed as `database + array + object + key`; an object in the `files` array is still an object, not a separate path-based cache category. Index catalogs and nodes are indexes and follow the same demand-based lifecycle. Do not add path-based whitelists or special cache branches to the core at this stage.

A disk copy alone does **not** create a subscription. A node subscribes to changes only while at least one local user or active operation needs the relevant data. Mutations generate change events; subscriptions determine which nodes receive those events and apply the corresponding local object/index updates. There is no periodic or background propagation to keep unused copies warm. For example, if 10 of 100 nodes currently need an array or index, the other 90 should not receive a mutation event solely to maintain their caches.

When the last local subscriber leaves, remove its local object and index copies. A configurable idle debounce may delay cleanup briefly when workers share a disk and a reconnect may land on another worker using the same disk. The debounce is an optimization, not a retention guarantee. If another local subscriber appears before cleanup, keep the copy active. Once demand reaches zero, stop syncing it; if retained temporarily, treat it as dormant and refresh or catch it up from the authoritative storage source before serving it again. The exact version/checkpoint or refresh protocol remains open. Removing a local copy does not delete authoritative data.

Any future opt-in retention, continued subscription, or bulk warming policy belongs in configurable object/array metadata and should be considered only after the core index and storage behavior is stable. Bulk transfer details (including packaging a whole array) are also future adapter behavior, not a reason to distinguish object types in the core cache policy. Updates should reach interested nodes after the authoritative write succeeds; delivery guarantees and recovery from missed events remain part of the later consistency design.

### Distributed availability index — implemented prototype

CoCreateDB maintains a local Cluster availability index beside each database, array, and object index. The recursive `createIndex` engine uses `indexDirectoryName: 'distributed'`; each entry stores an entity ID as its indexed value and a server ID as its `objectId`. The physical roots are `<root>/databases/distributed/`, `<root>/databases/<database-id>/arrays/distributed/`, and `<root>/databases/<database-id>/arrays/<array-id>/distributed/`.

`createDB({ nodeId })` adds references after local database, array, and object creation and removes local references on deletion. Updates and ordinary reads do not change availability. Array/database deletion preserves nested distributed directories so peer references survive deletion of local payloads. `updateDistributed()` is an idempotent local mutation and never broadcasts by itself.

The `@cocreate/cluster` integration exposes `server.DB`. Worker writes and availability changes are routed through the primary, which serializes DB writes to avoid concurrent filesystem index mutations by local processes. Local availability transitions send incremental `db.distributed` events; the primary applies incoming events without forwarding them to workers or rebroadcasting. Event payloads contain stable database/array/object IDs and a server ID, never document values. `COCREATE_DB_DIRECTORY` selects the shared local root.

This is not a complete distributed database protocol. Initial index transfer, startup reconstruction, missed-event recovery, multi-server document write coordination, multi-file transactions, crash recovery, and external storage adapters remain future work. The current CoCreateDB code has no external persistence adapter, so distributed files are not uploaded; any future adapter must exclude every `distributed/` subtree.

## 8. Storage adapters and object stores — future phase

CoCreateDB is designed to support:

- Local filesystem (first working reference).
- AWS S3 and S3-compatible object storage.
- Google Cloud Storage.
- Azure Blob Storage.
- Other cloud, network, or database adapters.

Cloud object stores are cheap and have useful durability/versioning/replication options, but are not literally attached disks, and same-region S3 access is not equivalent to local filesystem I/O. Object storage typically offers whole-object GET/PUT and prefix listing, **not** POSIX directory operations or native directory-to-ZIP downloads. Bulk export/archive creation would require a separate process. Very large objects are possible, but designing indexes as small independently addressable objects avoids streaming an entire multi-terabyte collection for ordinary queries.

Keep the index engine oblivious to where its nodes or the document payloads live. A storage adapter can decide where and how to retrieve, serialize, write, delete, and cache. Multiple storage destinations and read fallback are future orchestration policies, not assumptions of the index primitive.

## 9. AST workflows and distributed coordination — proposed

The CoCreateJS AST/workflow system may define **operation-level policies** for reads, writes, multi-destination fan-out, retries, fallback, replica placement, and synchronization. This is **not yet a hardwired requirement**. Prefer direct, low-overhead node I/O inside the hot index path; avoid interpreting a general AST workflow for each recursive node access unless benchmarks justify it.

Illustrative future flow:

```text
CRUD request
  -> CoCreateDB logical operation
  -> Index/query primitive (resolve candidate IDs)
  -> Storage routing policy / optional AST workflow
  -> FS / S3 / GCS / Azure adapters
  -> Optional replica/sync events
```

Potential integration with CoCreate Server's WebSocket mesh, IPC, pub/sub, and existing MongoDB-style CRUD wrappers is an opportunity, not a dependency for the standalone package. The wider system has discussed ephemeral nodes bootstrapping from peers, change subscriptions, snapshots, and optional LWW/CRDT strategies. These are future choices requiring explicit consistency rules.

### Historical design exploration (not current commitments)

An earlier architecture blueprint explored a LevelDB/classic-level local KV index, whole-array index snapshots, LWW-by-default event propagation, optional CRDT merges, and time/mutation-based snapshot schedules. The **later agreed design** in this conversation instead prioritizes recursive individually addressable JSON index nodes and a filesystem-backed reference implementation. Do not silently replace this with LevelDB or a monolithic `_index_snapshot.bin`. Snapshotting, LWW, CRDT, and pub/sub can be reconsidered as optional capabilities in later phases.

## 10. Durability, concurrency, and correctness risks

These issues are **not solved by the prototype** and must be addressed before calling CoCreateDB a distributed production database:

1. **Multi-node atomicity:** Splitting a leaf updates existing node, new sibling, parent, and possibly catalog. Individual atomic renames do not commit them as a unit. Need a publish/commit protocol, versioned immutable nodes, manifest pointer swap, WAL/journal, or equivalent.
2. **Concurrent writers:** Two servers modifying the same root can lose writes. Need concurrency control (single-writer lease, CAS/version checks, optimistic retries, consensus/quorum, or other explicit model).
3. **Object/index consistency:** Object write success and index write failure (or vice versa) creates inconsistency. Define ordering, recovery, and idempotency.
4. **Cache coherence:** Active subscribers can receive updates, but dormant disk copies intentionally stop receiving them. A returning subscriber must refresh or catch up before serving the dormant copy; the version/checkpoint protocol is unresolved.
5. **Uniqueness:** ObjectId generation reduces collision risk but does not itself enforce uniqueness across distributed writers.
6. **Read consistency:** Decide whether queries see a coherent tree snapshot during concurrent splits/deletions.
7. **Crash recovery:** Interrupted writes and orphaned nodes require detection and repair/garbage collection.
8. **Type semantics:** The prototype has explicit boolean and null branches, recursively indexes nested object leaves, and indexes array scalar values by field path. Missing values have no entry; date encoding, empty composite values, non-finite numbers, geospatial queries, and locale-sensitive string ordering need explicit contracts.
9. **Byte limits:** Serialized JSON size and provider limits differ; splitting must account for metadata overhead and unsplittable entries.
10. **Cost model:** Cheap bytes do not imply cheap request counts; index depth, GET/PUT latency, amplification, and cache hit rate need benchmarks.

A practical first milestone can deliberately be **single-process/single-writer**, with these limitations prominently documented.

## 11. Initial prototype status

The repository contains a filesystem-backed ESM index plus a `createDB({ directory })` factory exposing `send()` for database, array, and object CRUD. Database/array name catalogs resolve to stable IDs; object payloads and field indexes live beneath those IDs. The same recursive engine also backs sibling Distributed Index trees at database, array, and object levels. `@cocreate/cluster` initializes `server.DB`, routes worker writes through the primary, and exchanges incremental `db.distributed` events. Create indexes `_id` and supported field values independently; equality queries intersect candidates and range queries scan indexed type branches using shared JavaScript relational semantics. Indexes support number, string, boolean, and explicit null branches, with nested object leaves and array scalar values indexed by field path. Array object counts are indexed in their parent database catalog and checked against `_id` roots; catalog `catalogCount` tracks mappings, and node counts track subtree entries. An in-memory Map cache is opt-in.

The Node tests cover independent index operations, database/array CRUD and stable catalog IDs, object create/read/update/delete, automatic per-field indexes, equality and range query planning, reopening persisted nodes, field-index splits/removal, catalog root splits and recursive growth, legacy catalog migration, shared query/update utility semantics, object counts, empty-root pruning, alphabet/case/type queries, validation, Distributed Index partitioning and idempotency, duplicate object IDs across scopes, preservation of peer references during deletion, and the primary/worker event adapter. **These tests do not establish multi-file transaction safety, crash recovery, real multi-process durability, missed-event recovery, or initial Cluster synchronization.** Remote storage reads, subscriptions, and retention cleanup are not implemented.

## 12. Implementation roadmap

### Phase 1 — Index primitive and FS reference (current)

1. Harden the node/catalog schema and `get`/`set` mutation semantics.
2. Expand failure coverage for filesystem-backed catalog/root resolution and internal node access.
3. Test ordered comparisons, duplicate values, byte-size splits, recursive root growth, deletions, metadata, and persistence/restart.
4. Harden CRUD update/delete behavior with broader failure and partial-write coverage.
5. Add range-aware cursors, more complete filter planning, sort/limit/skip.
6. Define storage-provider reads, subscription updates, and local cache cleanup; then benchmark memory, serialized bytes, node reads/writes, and tree depth.

### Phase 2 — Storage abstraction and orchestration (planned direction)

1. Separate node/object I/O contracts from filesystem adapter.
2. Add cloud object-store adapters and optional cache/eviction policies.
3. Evaluate AST workflows for storage routing, fan-out, and read fallback.
4. Define consistent object+index commit/recovery semantics and multi-writer strategy.

### Phase 3 — Distributed capabilities

1. Implement initial availability-index synchronization and explicit local reconstruction.
2. Add missed-event recovery and version/checkpoint semantics.
3. Define authoritative storage commits, multi-file recovery, replica placement, compaction, and fault injection.

## 13. Decision register

| Topic | Status | Decision / open question |
|---|---|---|
| Branding | **Decided** | CoCreateDB / `CoCreateJS/db` / `@cocreate/db` |
| Language | **Decided** | JavaScript ESM, Node.js-first |
| Vocabulary | **Decided** | `database`, `array`, `object`, `key`, `value`, `index` |
| Persistence format | **Decided direction** | JSON data, not executable `.js` documents |
| Index entry point | **Decided** | `database + array + key`, default `_id` |
| Index topology | **Decided** | Recursive ordered nodes, opaque IDs, first/last/count |
| Value branches | **Current prototype** | Separate finite `number`, `string`, `boolean`, and explicit `null`; missing/compound values remain unresolved |
| Automatic indexes | **Decided direction** | Independently index every supported field path on create; no compound index creation required for field queries |
| Split | **Decided** | Local ~50/50 after insertion; byte-based preferred |
| Rebalancing | **Decided** | No mandatory neighboring redistribution; optional compaction |
| First adapter | **Decided** | Node.js filesystem; optional Map cache |
| Local object/index cache lifecycle | **Decided direction** | Apply one demand-based policy to all objects and indexes; stop syncing and remove local copies after the last local subscriber leaves, with optional shared-disk debounce |
| Retention overrides | **Future configurable option** | Object/array metadata may opt into retention or continued subscription after core behavior is stable |
| Dormant-copy freshness protocol | **Open** | If cleanup is delayed, define version/checkpoint validation or refresh-on-resubscribe |
| Exact public `set` signature | **Open** | Entry mutation vs root/node persistence must be clarified |
| Catalog scalability | **Prototype implemented** | Bounded recursive catalog tree rooted at `index.json`; same byte limit as field nodes |
| Query planner | **Planned** | Range pruning, compound predicates, pagination |
| AST storage workflows | **Proposed** | Policy-level orchestration; avoid hot-path overhead |
| Replication/consistency | **Proposed** | Define concurrency, versioning, atomic commits first |
| CRDT/LWW | **Explored** | Not a fixed baseline requirement |

## 14. Guidance for continuing in VS Code Codex

1. Read `AGENTS.md` and this document.
2. Inspect the current repository before assuming the prototype is present or identical to the chat-generated version.
3. Preserve decided semantics; surface open questions explicitly.
4. Implement the smallest useful increment and add executable tests.
5. Keep indexing independently importable; do not hardwire CoCreate Server, AST, S3, or any particular cloud provider into core algorithms.
6. Update both documents whenever architectural decisions change.

**Suggested opening prompt:**

> We are continuing CoCreateDB development in `CoCreateJS/db`. Read `AGENTS.md` and `ARCHITECTURE.md`, inspect the existing code, identify gaps between the prototype and the decided index invariants, and propose the smallest test-driven next implementation step. Keep `database + array + key` as the logical entry point and preserve the independently accessible Index primitive.
