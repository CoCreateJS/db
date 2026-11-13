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
          index.json         # field/type catalog and object length
          <opaque-id>.json
        objects/
          <object-id>.json
```

Database and array names are indexed metadata, not directory names. Their catalogs resolve names to stable 24-character ObjectIds, so renaming updates metadata without moving descendant data. Database metadata, array metadata, and stored objects all use the shared record contract: create indexes supported record values, read resolves through indexes, update reconciles old and new index values, and delete removes index entries and JSON. Metadata `created` and `updated` values use `{ on, by }`, matching object CRUD; the actor is populated from `user_id` or `clientId` when present. Array metadata's `length` is its total object length. Database metadata uses `arrayLength` and `objectLength`; database reads compose arrays and report array length from the recursive array catalog. Query result `count` remains the number of matching records returned before search and pagination. Metadata JSON contains a `config` object reserved for future policies such as encryption at rest; encryption behavior is not implemented.

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
- `length`: number of indexed entries in the subtree (for a leaf, its entry length).
- `first`: first ordered entry boundary `{ value, objectId }`.
- `last`: last ordered entry boundary `{ value, objectId }`.
- `entries`: ordered leaf array of `[value, objectId]` tuples, **or**
- `indexes`: ordered internal array of child references, each with `id`, `first`, `last`, `length`.

These fields let a parent choose a child without downloading its descendants, skip ranges, and propagate counts/boundaries after mutations. `first` and `last` are **actual values**, not first/last letters or fixed buckets. Equal values are ordered by `objectId` as a tie-breaker.

Example:

```json
{
  "id": "node-42",
  "length": 3,
  "first": { "value": 18, "objectId": "001" },
  "last": { "value": 25, "objectId": "003" },
  "entries": [[18, "001"], [22, "002"], [25, "003"]]
}
```

An internal node uses `indexes` instead of `entries`:

```json
{
  "id": "parent-1",
  "length": 3,
  "first": { "value": 18, "objectId": "001" },
  "last": { "value": 25, "objectId": "003" },
  "indexes": [
    { "id": "node-42", "length": 3,
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
4. Update leaf `length`, `first`, `last` and propagate changed child references/metadata upward.
5. Finish the local mutation without a byte measurement or structural split.
6. At replication serialization, measure the already encoded node. Reuse that encoding if within target. If oversized and usefully splittable, split locally, update ancestor/catalog references, then encode and send replacement nodes. Ancestors are checked when their own replication encodings are prepared.

### Split rule

**Split only at replication serialization**, approximately 50/50 by position. Do not measure individual entry byte weights or use entry count as the split trigger. Keep the original node ID for the left portion, allocate a new ID for the right sibling, and insert the sibling reference in the parent in sorted order. Never require reading or redistributing neighboring siblings or descendants merely to split. An internal-node split moves child **references**, not child payloads. If the root splits, create a new parent root and update the key/type root mapping.

```text
Before: Parent -> [A: 10..80] [C: 90..120]
Insert 35 into A; A exceeds maxBytes
After:  Parent -> [A: 10..40] [B: 50..80] [C: 90..120]
```

The 50/50 approach was chosen over moving only one/two overflow entries because tiny overflow siblings could proliferate and cause frequent repeated splits. A byte-balanced split provides capacity for future inserts in both nodes while retaining local write scope.

### Growth and cleanup

- Nodes can split at any depth; a parent may recursively split, including the root.
- Maintain correct `first`, `last`, `length` throughout affected ancestors.
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
- Early termination after enough matching entries for a limit; child `length` may help skip ranges for pagination.
- Dot-notation keys (e.g. `profile.location.city`) indexed as paths.
- Index-only answers for metadata operations when possible (e.g. key existence, candidate IDs, counts), with full-object hydration only when needed.

The current planner orders conjunctions using catalog lengths before scanning, stops on an empty candidate set, and can check expensive residual predicates against a small hydrated candidate set. Nested AND/OR clauses preserve their logical structure; negation only complements exact candidates. Numeric ranges and `_id` string ranges use bounded scans and binary seeking within leaves. Other string/object range operands conservatively verify documents because native JS comparisons can match unindexed ordinary-object values. Cross-type branches preserve native JavaScript comparison behavior. Sort and pagination still operate on hydrated matches; index-backed sort and streaming pagination remain future work. Indexing every supported field increases storage/write amplification; this is an intentional initial tradeoff in exchange for broad query capability, to be measured.

### Object mutations

The filesystem `send()` prototype supports create/read/update/delete for databases and arrays, plus object create/read/update/delete. Database and array names resolve through recursive name indexes to stable 24-character ObjectIds; internal index nodes use 32-character hexadecimal UUID-derived IDs. Rename updates a catalog entry and metadata while preserving the directory ID and descendant data. Database metadata uses `arrayLength` and `objectLength`; each array metadata record uses `length` for its total objects. Reads migrate legacy metadata fields (`count`, `arrayCount`, and `objectCount`) to these length fields through the indexed record update path. Query result `count` still describes matching records returned by the source. Deleting an array recursively removes its objects and indexes, and deleting a database recursively removes its arrays and data. Database and array update requests can merge a `config` object into metadata for future settings such as encryption policy; encryption itself is not implemented. Existing data in the previous `<database>/<array>` layout is not migrated automatically.

Object create generates/validates an ObjectId, stores the JSON object under the database/array, indexes `_id` and supported scalar field values, and converts dotted keys to nested object paths. Reads use equality and supported range indexes to narrow candidate IDs, then call shared `queryData` and `searchData` from `@cocreate/utils` to evaluate candidates. Sorting, projection, and pagination follow the shared Filter shape. Per-source count and cursor position are returned in `filter.storages`; the client owns the aggregate `filter.index`. Updates use shared `createUpdate`, compare old/new indexed values, remove stale entries (including removed keys), insert replacements, and update tree metadata. Deletes remove each object's index entries and JSON file. Empty key/type trees are pruned from the catalog. The catalog root's `length` tracks stored objects through `_id` entries and `catalogLength` tracks catalog mappings; child references' lengths describe catalog mappings in their subtrees. Field-index node lengths describe indexed entries in each node/subtree. CoCreateDB retains `$set` as a convenience; other update behavior comes from the shared utility.

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

Cache policy is separate from index correctness. Memory is a high-cost resource in CoCreate Server; avoid retaining raw JSON and parsed objects simultaneously for long periods. Standalone `createDB` defaults to `memoryCache: false`; the server integration enables `memoryCache: true`. This shared JSON cache loads only files actually read or written by operations and never scans the directory at startup. The separate index-only Map remains opt-in with `cache: true`. If a memory cache is enabled, it needs bounds/eviction and coherent writes before production use. A node may be modified by reference in memory, so callers must explicitly commit through the chosen mutation interface.

### Uniform object/index cache and subscription policy — decided direction

Apply one cache and subscription policy to CoCreate data, regardless of its content or intended use. Data remains addressed as `database + array + object + key`; an object in the `files` array is still an object, not a separate path-based cache category. Index catalogs and nodes are indexes and follow the same demand-based lifecycle. Do not add path-based whitelists or special cache branches to the core at this stage.

A disk copy alone does **not** create a subscription. A node subscribes to changes only while at least one local user or active operation needs the relevant data. Mutations generate change events; subscriptions determine which nodes receive those events and apply the corresponding local object/index updates. There is no periodic or background propagation to keep unused copies warm. For example, if 10 of 100 nodes currently need an array or index, the other 90 should not receive a mutation event solely to maintain their caches.

When the last local subscriber leaves, remove its local object and index copies. A configurable idle debounce may delay cleanup briefly when workers share a disk and a reconnect may land on another worker using the same disk. The debounce is an optimization, not a retention guarantee. If another local subscriber appears before cleanup, keep the copy active. Once demand reaches zero, stop syncing it; if retained temporarily, treat it as dormant and refresh or catch it up from the authoritative storage source before serving it again. The exact version/checkpoint or refresh protocol remains open. Removing a local copy does not delete authoritative data.

Any future opt-in retention, continued subscription, or bulk warming policy belongs in configurable object/array metadata and should be considered only after the core index and storage behavior is stable. Bulk transfer details (including packaging a whole array) are also future adapter behavior, not a reason to distinguish object types in the core cache policy. Updates should reach interested nodes after the authoritative write succeeds; delivery guarantees and recovery from missed events remain part of the later consistency design.

### Distribution index partitions — implemented prototype

The Distribution Index now tracks **regular index files and their holders**. Its recursive tree is stored locally under `<root>/distribution/partitions/index/`; each entry maps a regular index partition path (including the database/array/index hierarchy) to one or more Cluster node IDs. It contains no document payload and is never persisted to external storage. Regular index partition JSON retains its normal boundary metadata (`first`, `last`, and `length`) and sorted entries.

The filesystem `createIndex` writer reports index root/node writes and removals to `createDB`. A local write adds the current node as a holder. A peer acquisition writes the complete bounded partition locally and registers the acquiring node. A changed partition is sent to the nodes already holding it; availability changes are sent to the Cluster so each node can maintain the holder map. Duplicate adds/removes are idempotent. Partition requests are targeted, correlated, and time-bounded. Missing local roots/children can be fetched while normal index traversal proceeds; an advertised partition that no holder can return raises an error rather than appearing as an empty index. Worker operations and holder updates route through the primary.

The older database/array/object entity-availability map remains for compatibility with exact-ID metadata/document acquisition. It is not the intended query-location model; the agreed direction is to traverse the regular index and its partition-holder references, then resolve the resulting data locally or through configured persistence. CoCreateDB initializes on the Cluster server instance as `server.db`; CRUD consumes that instance for routed requests.

Current limits: a clean node does not yet request and import a full initial partition-holder snapshot; no file-level external storage adapter is wired for index fallback or durable writes; and chunked terminal-array value files are not yet acquired as index partitions. Regular object create/update/delete now sends the full unprojected document and current database/array metadata to the union of nodes holding its old or new index partitions. Receivers serialize partition and document events so the index updates are applied before the document mutation. This is best-effort Cluster propagation: there is no durable outbox, acknowledgement/retry protocol, transaction across files, or version conflict resolution yet. When an external storage adapter is added, durable storage writes must become the persistence boundary before a mutation is considered committed; cluster propagation will remain separate from the source-of-truth write. The Cluster whitelist/connection path remains the trust boundary; optional message signing remains only a defense-in-depth TODO.

### Terminal array indexing — implemented

`flattenIndexValues()` descends through ordinary object properties to full dot-notation paths, then treats an array as one terminal value. It does not create positional keys or nested property paths from array members. The recursive index stores a digest in the bounded array branch and chunks the complete JSON array into bounded files under that field index's `values/` directory. `index.scan({ type: 'array' })` hydrates the full array value. Updates replace one terminal array entry, not an entry per position. Query planning uses the array branch to find candidate documents for membership and element operators; shared `queryData` validates the query. Queries into object fields inside arrays remain correct but scan candidate documents because those paths are not independently indexed.

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

The repository contains a filesystem-backed ESM index plus a `createDB({ directory })` factory exposing `send()` for database, array, and object CRUD. Database/array name catalogs resolve to stable IDs; object payloads and field indexes live beneath those IDs. The recursive Distribution Index maps regular index partition paths to holder nodes. The Cluster adapter acquires missing partitions over targeted requests and sends changed partition contents to current holders; the older entity availability map remains for exact-ID metadata/document acquisition. Create indexes `_id` and supported field values independently; equality queries intersect candidates and range queries scan indexed type branches using shared JavaScript relational semantics. Indexes support number, string, boolean, null, and terminal array branches. Ordinary objects flatten to dot paths; full array values are stored in bounded chunk files so array positions and nested members do not create independent index entries. Array object lengths are indexed in their parent database catalog and checked against `_id` roots; catalog `catalogLength` tracks mappings, and node lengths track subtree entries. An in-memory Map cache is opt-in.

The Node tests cover independent index operations, database/array CRUD and stable catalog IDs, object create/read/update/delete, automatic field indexes, equality/range/logical queries, terminal array membership and element matching, bounded array value chunks, reopening persisted nodes, field-index splits/removal, catalog root splits and recursive growth, legacy catalog migration, shared query/update utility semantics, object lengths, empty-root pruning, alphabet/case/type queries, validation, Distribution Index partition and holder operations, partition acquisition and targeted updates to existing holders, duplicate object IDs across scopes, preservation of peer references during deletion, cold catalog resolution, complete peer fetch and local materialization, request correlation/timeouts, document mutation propagation to partition holders, and the primary/worker event adapter. **These tests do not establish multi-file transaction safety, crash recovery, real multi-process durability, missed-event recovery, initial partition snapshot synchronization, external storage fallback, terminal-array chunk transfer, or user subscription lifecycle.**

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
| Index topology | **Decided** | Recursive ordered nodes, opaque IDs, first/last/length |
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
| Query planner | **Prototype implemented** | Catalog length planning, bounded numeric/string ranges, nested logical predicates; streaming pagination remains planned |
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

### Catalog branch summaries and query planning — implemented

Each catalog leaf mapping is `[key, type, rootId, { length, first, last }]`. The summaries describe the value branch, while catalog node boundaries describe ordered `(key, type)` mappings. Every value insertion/removal refreshes the summary even when its root ID stays the same. `getMetadata(database, array, key)` returns branch references containing `id`, `length`, `first`, and `last`; it does not fetch upgraded value roots. The logical `db.index` facade exposes the same method.

Legacy node/child-reference `count` and `catalogCount` fields normalize to `length` and `catalogLength` on access. Legacy mappings without summaries fetch their value root only when metadata is requested and are upgraded on branch mutation. This is lazy compatibility, not an eager rewrite of existing storage. Query-result `count` remains unchanged.

Planning memoizes metadata within one query. Branch lengths are work estimates, not distinct-value statistics; terminal-array scans carry a fourfold heuristic penalty because they hydrate stored array values. Small candidates (at most 256, and less than one quarter of the estimated next scan cost) can be checked directly. A dotted index cannot be assumed complete when an ancestor has a terminal-array branch, so that predicate conservatively falls back to document verification. `_id` is automatically indexed as a string and supports bounded forward/reverse range scans.

### On-demand process memory cache — implemented

The server no longer preloads all persisted JSON. Enabling `memoryCache` registers the storage root without filesystem I/O. `readMemoryJSON()` parses a missing entry on demand and retains it; the initial caller and subsequent callers receive the same live reference. Successful object/index/chunk writes update the shared memory value, and deletions remove matching cached paths. `db.ready` resolves without loading files. Cache contents are shared by directory across instances within one process, and the server-integrated engine and cache exist only in the primary process.

`memoryStats().serializedBytes` is a serialized-size estimate, not a heap measurement. There is no automatic eviction or hard limit yet. A process-wide estimated-byte budget with LRU eviction is proposed; an optional idle timeout can supplement it. Eviction must not delete persisted files. This process-local read-through cache does not implement subscription tracking, dormant-copy refresh, snapshot isolation, or independent multi-process writer coherence. The decided demand/subscription lifecycle above remains the longer-term design.

### Query and update operator validation — implemented

The Utils and DB operator matrices exercise every currently listed field/logical query operator and all thirteen update operators. Dotted array traversal matches actual leaves rather than exposing a synthetic array to `$size`/`$type`/`$all`. Update `$set` is forwarded intact; rename destinations resolve from the document root; `$each` initializes a missing array. Unsupported update operators and invalid increments fail rather than silently overwriting fields. DB validates global operator paths and `_id` destinations before applying a prepared property-slot plan to the live record. Regression cases inspect values, all affected business-field index entries, and persisted reopening with memory caching on and off. These tests do not establish multi-file transaction or crash-recovery safety.

Array update syntax remains CoCreate-specific: standalone `$each`, insertion with `$splice` or ordinary bracket paths, replacement with `$set`, deletion aliases `$slice`/`$delete`/`$unset`, last-element `$pop`, first-element `$shift`, and deep-equality `$addToSet`/`$pull`. MongoDB-style modifier syntax and predicate-based `$pull` remain outside this contract.


### Write performance and primary-owned CRUD reads — implemented

The index layer and both cache layers share the same node references returned by
`readMemoryJSON`. Traversal does not clone nodes.
`Index.locatePartitions` uses per-pass read-only node/catalog snapshots and returns
unique partition paths; it does not retain those snapshots across mutations.
Object mutation holder discovery uses this lookup and is omitted when no document
mutation publisher is configured. Distribution publishing still includes holders
of unchanged fields and both old and new partitions.

Normal worker CRUD reads and writes are forwarded to the primary. Worker requests
are serialized there so a read following a completed write uses the primary's
current catalog and document cache. This avoids relying on per-process cache
invalidation; direct standalone writers remain outside this coordination contract.
Workers expose only the IPC driver and instantiate no engine or payload cache.
Reads, writes, and incoming document/index/availability changes share one queue.
The cost is one IPC round trip per worker CRUD and possible queuing behind writes.

The standalone write-through response boundary still waits for document and index
writes. The server now defaults to the staged primary write-behind model below;
its acknowledgment means that the document revision is applied in memory.
Neither mode adds fsync/WAL or crash-atomic multi-file commits. Regression
tests cover worker processes without local engines, concurrent queued updates,
fresh query results after an index-blocked update, split-catalog partition lookup, retained holders, and detached
cache values.

### Staged primary acknowledgments — implemented

The primary applies document create/update/delete in memory and responds through
existing CRUD/IPC. Shared Utils `createUpdate` remains the update engine. Catalog
metadata is immediately indexed in memory. Payload indexing runs afterward on
the same primary operation queue. While payload indexes lag, queries union their
index candidates with pending object IDs, load the current memory record, omit
pending deletions, and verify the complete query before filtering/pagination.
Thus filtered reads, updates, and deletes do not depend on stale indexes alone.

A pending index entry identifies database/array/object, retains the previously
indexed record, and tracks a monotonically increasing per-process document
revision. Repeated updates coalesce to the latest memory value. Reconciliation
uses a memory checkpoint for changed document/index/holder files; a failure
restores partial index changes and retains the pending document for retry. Only
changed paths are journaled temporarily, not the whole cache. This checkpoint is
not a durable journal. Completed holder-targeted index/document changes dispatch
through Mesh, and `db.indexed` goes through existing IPC to local workers. Local
workers retain no independent DB engine. Disk writes do not gate these messages.

All JSON writes, chunk writes, and removals use a root-scoped write-behind adapter.
Its sequential queue stores addresses, operations, and revisions, resolving the
current cached JSON only when flushing. An immutable revision snapshot feeds
local serialization and the optional external storage hook. New revisions arriving
during I/O stay dirty; pending paths cannot be evicted. Cached persisted values
remain available until explicit clearing; LRU/byte limits are not implemented.
Persistence has a configurable per-path trailing cooldown (25 ms by default),
with a maximum wait of 1000 ms once indexing is ready. Repeated changes reset the
cooldown within that bound. Indexing/propagation remain immediate, and explicit
flush bypasses cooldown. Dirty entries remain pinned through all required acks.

A configured storage workflow is required acknowledgment, not optional fallback
when temporarily offline. Without a configured workflow, disk completion is
sufficient. The configurable workflow hook has no seeded implementation here.
`flush` drains indexing then persistence; `close` drains and unregisters the
adapter, and the server registers it for graceful shutdown. Draining requires
quiescence to establish a final boundary. Automatic retries remain process-local.
A failed index entry conservatively gates persistence across its root because
catalog/index files are shared. A process crash can lose acknowledged revisions;
Mesh dispatch alone does not establish durable replica storage or multi-node
commit. Crash recovery, durable retry journals, and cross-server conflicts remain
open. Standalone DB callers retain write-through behavior by default.

Deletion records a `deleted/<objectId>.json` lifetime marker containing the old
`created.on`; it is retained and persisted independently of the removed payload.
The marker rejects normal updates to missing/deleted IDs and stale peer copies.
Explicit recreation/upsert creates a new, locally monotonic creation timestamp,
clears the marker, and indexes the new lifetime. Replicated stale sets/deletes
are checked against the marker/current lifetime before application. Ordinary
updates cannot alter `created.on`. ID-only requests cannot distinguish old and
new lifetimes after intentional ID reuse; callers must include the creation date
for that check. Creation timestamps are not a complete distributed version clock.
Marker retention/purge and cross-server causal ordering remain open policies.

### Resolved-document responses and propagation — implemented

Object updates validate shared `createUpdate` against a view of proposed property
slots, then commit those slots to the owned live document. Replies, holder-targeted
Mesh mutations, and `db.indexed` worker notifications carry the complete resolved
record. Original request operators are removed from successful response envelopes;
no outgoing `$set`/`$unset` document patch is generated. Unchanged fields remain in
the delivered record. No-op replies return the full record without scheduling
additional document/index persistence.

Deferred index work coalesces by object address and publishes the latest complete
live state. Create and recreated-lifetime records publish `set`; existing-lifetime
records publish `update` with creation-lifetime metadata. Replicas install that
complete state without evaluating update operators or fetching a missing base.
Replacement removes absent fields while preserving an existing cached record's
identity. Deletion markers and creation-lifetime checks remain enforced.

The full record remains authoritative for queries, index reconciliation, and local
persistence. Shared Utils update semantics and external persistence hooks are
unchanged. This contract adds no cross-server causal ordering, conflict resolution,
or multi-file transaction guarantees.

### Organization-owned logical storage hierarchy — implemented

The public DB service now requires `organization_id`, logical `storage`, and
`database` in every request. CRUD imports DB directly (using the server's primary
engine/worker proxy when provided), resolves hostname defaults, then fills absent
storage/database as `production` / `app`. CRUD leaves array unchanged, including
absence, and performs no provider selection. Its organization registry queries
use explicit production/app scope and `host: null` to prevent host-default
recursion without array-specific routing. The configured organization can
bootstrap via local CRUD before any organization/key records exist.

The root path is `<root>/<organization_id>/storages/<storage_id>/databases/...`.
`storages/index` is a recursive name catalog. Storage records and their automatic
name/ID indexes use the existing record/index primitives. Database and array name
catalogs retain their previous relative layout inside the storage ID directory.
Storage rename changes the reference and metadata, preserving all descendants.
Storage metadata and deletion markers propagate through DB control events.

The scoped service lazily creates one independent engine per resolved namespace,
sharing the root JSON cache and a single write-behind persistence queue. The
existing object engine remains an internal independently testable primitive;
its relative database/array layout is unchanged. Root sends serialize namespace
creation to avoid duplicate IDs from simultaneous first writes on one node.
Global cross-server creation/name conflicts still need distributed coordination;
conflicting stable IDs fail instead of silently aliasing separate namespaces.

Entity references and peer fetches carry organization/storage IDs. Index partition
addresses include the full prefix. Mesh carries tenant identity in a nested scope
because a top-level organization_id selects client-message routing. The existing
IPC wrapper likewise continues to carry CRUD requests inside data. Root index
helpers require explicit scope; regular lower-level indexes remain independent.

Old root-level datasets are not implicitly assigned to an organization or moved.
The user will delete/rebuild them and seed bootstrap data through `coc crud`.
No storage-provider migration or endpoint redesign is part of this pass.

### DB-owned recipient distribution — implemented propagation

DB derives recipient references from stable entity addresses, registers originating
worker IDs in `Workers.distribution`, and emits `db.distribution.set` to register
client IDs in `Socket.distribution`. Controls carry tenant identity inside `data`
and never go to socket clients. Registration completes before replying to CRUD.
Both maps use `Map<reference, Set<recipientId>>`; normal CRUD use adds recipients,
including use of an existing distribution. Exact document identity is preserved;
list reads also register array scope to include future documents. List delivery
is conservative rather than a server-side per-query membership service.

The existing primary IPC router uses these references to select workers, and
Socket uses them to select clients while retaining authorization and requester
replies. Applied peer document changes are delivered through the same references.
No browser registration is required. Elements' subscription handler and Socket's
legacy subscription APIs have been removed; CRUD uses DB-owned distribution.
This phase implements propagation only: new-map removal, stale recipient cleanup,
and reconstruction after restart remain undecided and unimplemented.

### Live-reference core — current contract (supersedes detached-copy/rollback descriptions above)

Checkpoint `3244ff0` preserves the implementation before this refactor. Cache,
index traversal, CRUD values, and outgoing distribution payloads now retain live
references. The optional index cache holds the same node as the shared cache.
Splits splice entries into a new sibling while preserving the original node;
catalog root promotion/collapse retains the stable root object. Indexed terminal
arrays retain their owned values instead of decoding their chunks on every scan.

Update validation runs the shared update utility against a view containing only
proposed property slots. Existing objects/arrays are not copied or modified by
that validation. If valid, the prepared assignments/deletions apply to the live
record. There is no general tree rollback journal. This is validation-before-
attachment, not a multi-file transaction. Unexpected structural/transport failures
after application do not imply that the already-applied memory state was undone.

Before-state for index maintenance consists of field names, scalar values, and
terminal-array digests, not a previous document snapshot. Removing an obsolete
array index uses its stored digest even when its live array has since changed.
Update replies and queued propagation retain the full live document. Serialization
observes its current values, including changes that reverted before dispatch.
Payload data is not cloned for Mesh; JSON serialization
is the process/transport boundary. Routing envelopes, projections, result lists,
and new split siblings are new containers, not copies of database-owned datasets.
Projection leaves retain value references and do not remove fields from the source.

`memoryOnly: true` enables shared memory and disables file reads/writes, the
write-behind persistence adapter, and server provider fallback/saves. It is the
validation mode for this phase. No existing persistent dataset is loaded in that
mode. Cache/index/distribution work can be flushed with `flushIndexes()`/`flush()`.
Externally supplied objects become DB-owned live values: do not reuse a create
input as an immutable template or mutate it outside DB APIs if index maintenance
is required. A live reference is not an isolated historical snapshot.

The default 128 KiB node size is a preferred split target. Large indivisible
entries/boundaries and minimum-fanout nodes can exceed it. They are valid nodes;
remote partition acceptance uses the same policy. A failed background index job
remains pending with `indexError` and is not retried indefinitely by a timer;
explicit flush or new work can attempt it again. No progress/retry console logging.

Persistence redesign and provider snapshot semantics are out of scope for this
phase. `src/persistence.js` is unchanged from the checkpoint; its existing external
storage snapshot hook is not part of the no-clone, memory-only validation. Existing
persistent-mode examples must not be taken as proof of durability/rollback under
this new live-reference contract. IPC and real-network serialization inherently
construct data in another process; this contract removes DB-side defensive copies.

## Replication serialization and private file-byte sidecars — implemented

Index node encoding is the sole structural split trigger. The 128 KiB preferred
target applies to the encoded node, not its routing envelope. Mutations maintain
live entries, lengths and boundaries without size calculations. Splits move
references at the positional midpoint and update ancestors and field catalogs.
Queued updates for the same holder/path are coalesced within propagation. New
siblings and changed ancestors are delivered to the original holder; other holders
receive their normal updates. Mesh accepts the prepared frame to avoid a second
serialization. Oversized single entries and minimum-fanout internal nodes remain
valid. Unreplicated standalone indexes can grow above the preferred target.

Terminal arrays are retained whole in memory and written as `values/.../value.json`;
legacy numbered array chunks remain readable. They are data, not index partitions.
No byte-bound fragmentation happens during array mutations.

Successful local disk writes capture bytes from their existing complete-file
encoding. A private `.bytes` JSON sidecar per directory maps filenames to their
last-persisted UTF-8 lengths. Write-behind persistence batches these updates per
pass; deletion removes the corresponding filename. The sidecars are not indexed,
replicated, included in data payloads, or consulted by splitting. They exclude
sidecar overhead and do not account for pending memory changes, allocated blocks,
compression, or global replica deduplication. No existing files are backfilled;
custom disk writers own this measurement. No automatic aggregate or telemetry job
is added. Sidecars are observational metadata, not a durable transaction journal.

### Legacy provider recovery is not tree persistence

`db.externalPersistence: true` opts into legacy **object reads only** for recovery.
It defaults off; `db.persistence: false` or `memoryOnly: true` also disables it.
External create/update/delete and external workflow writes remain disabled. MongoDB
is a temporary source of legacy records, not a persistence adapter for the tree.

On a local/peer read miss, the provider receives an unprojected query without
source-document metadata or update operators. Complete returned records
are installed through the local object/index pipeline, then the original read is
served locally with its projection/paging. Existing live records and deletion
markers win over provider responses. Index reconciliation completes before the
normal local disk queue becomes eligible; `db.flush()`/graceful close drains it.
Memory acknowledgment is not a crash-durability guarantee before that queue drains.

Local documents, namespace catalogs, indexes and their private byte sidecars
survive restart through local filesystem persistence. Future bucket persistence
must store that file/tree representation too; this recovery bridge does not add
MongoDB-specific tree encoding or redefine persistence as object forwarding.
Disable `db.externalPersistence` and restart after the required records have been
recovered. Existing local DB directories are not moved or silently migrated.
