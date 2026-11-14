# CoCreateDB — Architecture & Design Decisions

### Local and peer distribution — implemented

`distribution.local` is the authoritative local holder inventory; existing
distribution directories store only locally authored entries, using a stable
local marker rather than the process's current server ID. `distribution.peers`
merges per-peer contributions in memory and excludes this node. Incoming peer
snapshots and changes never enter the file/index writer. Public holder lookups
combine both views for existing consumers.

Control connection establishment exchanges complete local inventories using
`db.distribution.sync`, with one reply. A complete snapshot replaces only its
sender's contribution. Session/revision metadata prevents older snapshots from
undoing newer changes. Disconnect forgets peer holdings; reconnect rebuilds them.
Snapshots enumerate namespace catalogs and holder indexes, not document contents.
The current exchange sends one full inventory envelope; batching large inventories
is not implemented. Existing legacy ownership under a different server ID cannot
be inferred safely and is not silently adopted.

`db.disk` defaults true. False uses the same memory-backed file representation
for data and local distribution without filesystem reads/writes. It is independent
of the external persistence feature gates. Explicit `memoryOnly` still disables
external persistence too. Disk writes retain the existing write-behind durability
boundary; pending changes are not crash-durable until flushed.

**Repository:** `CoCreateJS/db`
**npm:** `@cocreate/db`
**Product and README title:** **CoCreateDB**
**Status:** Implementation and design reference; flat file layout updated 2026-11-14

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

A logical array contains independently addressable JSON records. Physical files
are flat within the organization; logical ownership lives in catalogs:

```text
<root>/<organization_id>/
  root.json
  indexes/<indexId>.json
  storages/<fileUUID>.json
  databases/<fileUUID>.json
  arrays/<fileUUID>.json
  objects/<fileUUID>.json
  values/<valueId>.json
  deleted/<deletionId>.json
  distribution/...
```

`root.json` is permanent, carries the format marker `cocreate-uuid-v1`, and points
to the storage catalog. Each storage/database/array record carries an `index`
reference to its child catalog. Root and empty storage catalog are initialized
together; child catalogs are initialized with their parent records. Catalogs and
field indexes use the same recursive splitting engine. Renames change indexed
names; they do not move files or change IDs.

Public `_id` values remain 24-character ObjectIds. Every record has a separate
32-character UUID filename. Index leaves store `[fieldValue, fileUUID]`, including
`[_id, fileUUID]` in the ID index. Logical catalog namespaces derive stable root
IDs from immutable entity IDs; they are not filesystem directories. In memory,
file identity is non-enumerable Symbol metadata on the actual live record. Peer
envelopes carry UUIDs explicitly because JSON omits Symbols. Disk stores raw JSON
records without wrappers or transport operators.

Metadata `created` and `updated` use `{ on, by }`; the actor comes from `user_id`
or `clientId`. Array metadata uses `length`; databases use `arrayLength` and
`objectLength`. Query `count` remains the number of matched results. Configuration
is ordinary metadata; encryption is not implemented. Existing unversioned datasets
are rejected before initialization writes and require a separate migration.

### JSON versus executable JavaScript files — decided

The discussion considered `.js` modules with `export default { ... }`, but concluded that JSON is the better persistence representation. Importing JavaScript does not eliminate parsing/compilation, has module cache and code-execution implications, and does not avoid serializing when saving a changed snapshot. JSON is data-only, efficiently parsed, and matches the existing serialized socket transport. JavaScript mutations occur in memory; persistence serializes the resulting state. Arbitrary functions (e.g. `Date.now()`) must not run simply because a document is read.

The serialized representation of special values (dates, coordinates, ObjectIds, binary, etc.) must be specified by a codec/schema layer; do not assume raw JSON preserves every JS type. Geo/spatial queries are a future query/index extension, not a reason to execute document code.

### Object identifiers

ObjectIds are the preferred identity and default enumeration key. Timestamp-bearing ObjectIds provide a useful deterministic order that often approximates creation time; they do **not** guarantee globally strict insertion order across independently writing distributed nodes. Enforce uniqueness via identifier generation and/or write coordination, not just a timestamp assumption.

## 4. Logical addressing and index hierarchy — decided

**Entry point:** `database + array + key`. For example:

```js
await Index.read('production', 'users', 'age')
await Index.read('production', 'users', '_id')
```

When a query has no filter/sort key, use the `_id` index to enumerate objects. A field catalog for each `database + array` maps `(key, type)` pairs to index roots. The field catalog is itself a recursive ordered tree. The catalog ID remains stable in the organization-level indexes directory; when its serialized size exceeds `maxBytes`, its entries move into 32-character hexadecimal UUID-derived child files and the root points to those children. Further splits can add levels. Each type branch is also a recursive ordered tree of individually persisted nodes. Node IDs are internal traversal references, not the public logical address.

```text
production / users
  └── Catalog tree (stable root ID)
       ├── _id ── string tree ── ordered ObjectIds
       ├── age
       │    ├── number tree ── recursive nodes ── (value, objectId) leaves
       │    └── string tree ── recursive nodes ── (value, objectId) leaves
       └── profile.location.city
            └── string tree ── recursive nodes ── (value, objectId) leaves
```

The catalog uses the same configured byte limit and recursive split strategy as field indexes. Its stable root file may contain leaf entries or child references, but stays bounded; catalog nodes share the flat `indexes/` directory and are marked with `kind: 'catalog'`.

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

The filesystem `send()` prototype supports create/read/update/delete for databases and arrays, plus object create/read/update/delete. Database and array names resolve through recursive name indexes to stable 24-character ObjectIds; internal index nodes use 32-character hexadecimal UUID-derived IDs. Rename updates a catalog entry and metadata while preserving file UUIDs and descendant data. Database metadata uses `arrayLength` and `objectLength`; each array metadata record uses `length` for its total objects. New-format metadata stores these length fields directly; old dataset migration is separate. Query result `count` still describes matching records returned by the source. Deleting an array recursively removes its objects and indexes, and deleting a database recursively removes its arrays and data. Database and array update requests can merge a `config` object into metadata for future settings such as encryption policy; encryption itself is not implemented. Existing data in the previous `<database>/<array>` layout is not migrated automatically.

Object create generates/validates an ObjectId, stores the JSON object under its file UUID, indexes `_id` and supported scalar field values, and converts dotted keys to nested object paths. Reads use equality and supported range indexes to narrow candidate IDs, then call shared `queryData` and `searchData` from `@cocreate/utils` to evaluate candidates. Sorting, projection, and pagination follow the shared Filter shape. Per-source count and cursor position are returned in `filter.storages`; the client owns the aggregate `filter.index`. Updates use shared `createUpdate`, compare old/new indexed values, remove stale entries (including removed keys), insert replacements, and update tree metadata. Deletes remove each object's index entries and JSON file. Empty key/type trees are pruned from the catalog. The catalog root's `length` tracks stored objects through `_id` entries and `catalogLength` tracks catalog mappings; child references' lengths describe catalog mappings in their subtrees. Field-index node lengths describe indexed entries in each node/subtree. CoCreateDB retains `$set` as a convenience; other update behavior comes from the shared utility.

## 7. Index access and filesystem reference adapter

The public root is addressed **logically**, not solely by internal ID:

```js
Index.read(database, array, key = '_id')
Index.create(database, array, key, value, objectId)
Index.update(database, array, key, value, objectId)
Index.delete(database, array, key, value, objectId)
```

The CRUD names replace `get`/`set`/`remove` in index consumers. Create and update
currently both retain the old entry insertion behavior; replacing a value still
requires deleting its old entry first. Further index behavior is deferred. One
handler dispatches `index.<operation>` envelopes with `index: [{ key, value,
objectId }]`; read entries need only `key`. Whole-partition I/O remains separate.
Private node operations take resolved paths/IDs. Storage errors must not be
treated as missing indexes.

The reference implementation uses Node.js filesystem JSON and an optional shared
live-object cache. Its flat layout and root manifest are defined in section 3.

The engine begins with a logical name lookup; after finding the stable database/array ID and index root, it follows child IDs directly without re-running logical lookup for every tree node. The `get`/`set` boundary is self-contained so later implementations can use local disk, object storage, network peers, cache tiers, or multiple destinations. Path construction belongs in the adapter/resolver, **not** in recursive algorithms. Validate logical names and opaque IDs to prevent traversal.

Cache policy is separate from index correctness. Memory is a high-cost resource in CoCreate Server; avoid retaining raw JSON and parsed objects simultaneously for long periods. Standalone `createDB` defaults to `memoryCache: false`; the server integration enables `memoryCache: true`. This shared JSON cache loads only files actually read or written by operations and never scans the directory at startup. The separate index-only Map remains opt-in with `cache: true`. If a memory cache is enabled, it needs bounds/eviction and coherent writes before production use. A node may be modified by reference in memory, so callers must explicitly commit through the chosen mutation interface.

### Uniform object/index cache and subscription policy — decided direction

Apply one cache and subscription policy to CoCreate data, regardless of its content or intended use. Data remains addressed as `database + array + object + key`; an object in the `files` array is still an object, not a separate path-based cache category. Index catalogs and nodes are indexes and follow the same demand-based lifecycle. Do not add path-based whitelists or special cache branches to the core at this stage.

A disk copy alone does **not** create a subscription. A node subscribes to changes only while at least one local user or active operation needs the relevant data. Mutations generate change events; subscriptions determine which nodes receive those events and apply the corresponding local object/index updates. There is no periodic or background propagation to keep unused copies warm. For example, if 10 of 100 nodes currently need an array or index, the other 90 should not receive a mutation event solely to maintain their caches.

When the last local subscriber leaves, remove its local object and index copies. A configurable idle debounce may delay cleanup briefly when workers share a disk and a reconnect may land on another worker using the same disk. The debounce is an optimization, not a retention guarantee. If another local subscriber appears before cleanup, keep the copy active. Once demand reaches zero, stop syncing it; if retained temporarily, treat it as dormant and refresh or catch it up from the authoritative storage source before serving it again. The exact version/checkpoint or refresh protocol remains open. Removing a local copy does not delete authoritative data.

Any future opt-in retention, continued subscription, or bulk warming policy belongs in configurable object/array metadata and should be considered only after the core index and storage behavior is stable. Bulk transfer details (including packaging a whole array) are also future adapter behavior, not a reason to distinguish object types in the core cache policy. Updates should reach interested nodes after the authoritative write succeeds; delivery guarantees and recovery from missed events remain part of the later consistency design.

### Distribution index partitions — implemented prototype

The Distribution Index now tracks **regular index files and their holders**. Its recursive tree is stored locally under `<root>/distribution/partitions/index/`; each entry maps a regular index partition path (organization ID plus `indexes/<indexId>.json`) to one or more Cluster node IDs. It contains no document payload and is never persisted to external storage. Regular index partition JSON retains its normal boundary metadata (`first`, `last`, and `length`) and sorted entries.

The filesystem `createIndex` writer reports index root/node writes and removals to `createDB`. A local write adds the current node as a holder. A peer acquisition writes the complete bounded partition locally and registers the acquiring node. A changed partition is sent to the nodes already holding it; availability changes are sent to the Cluster so each node can maintain the holder map. Duplicate adds/removes are idempotent. Partition requests are targeted, correlated, and time-bounded. Missing local roots/children can be fetched while normal index traversal proceeds; an advertised partition that no holder can return raises an error rather than appearing as an empty index. Worker operations and holder updates route through the primary.

The older database/array/object entity-availability map remains for compatibility with exact-ID metadata/document acquisition. It is not the intended query-location model; the agreed direction is to traverse the regular index and its partition-holder references, then resolve the resulting data locally or through configured persistence. CoCreateDB initializes on the Cluster server instance as `server.db`; CRUD consumes that instance for routed requests.

Current limits: inventory exchange is implemented over control-peer connections, but full inventories are not yet batched. File-level workflow persistence fallback and terminal-array value-file acquisition are not wired. Creates/deletes publish full records; updates publish `$update` patches and current database/array metadata to affected holders. A missing base is acquired from the sender without replaying an already included patch. This remains best-effort propagation without a durable outbox, distributed conflict policy, or multi-file transaction. Response ordering and external acknowledgment policy remain follow-up decisions; do not impose a new durability boundary implicitly.

### Terminal array indexing — implemented

`flattenIndexValues()` descends through ordinary object properties to full dot-notation paths, then treats an array as one terminal value. It does not create positional keys or nested property paths from array members. The recursive index stores a digest in its array branch and saves the complete live array in an organization-level `values/<id>.json` file. Missing value files can be acquired from known peers or recovered from the locally held owning record. `index.scan({ type: 'array' })` hydrates the full array value. Updates replace one terminal array entry, not an entry per position. Query planning uses the array branch to find candidate documents for membership and element operators; shared `queryData` validates the query. Queries into object fields inside arrays remain correct but scan candidate documents because those paths are not independently indexed.

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

CoCreate Server integration uses the existing Cluster mesh and worker IPC. The standalone engine remains usable independently. Inventory exchange and worker/client delivery are implemented; distributed ordering, deduplication, LWW/CRDT policy, and recipient cleanup remain separate decisions.

### Historical design exploration (not current commitments)

An earlier architecture blueprint explored a LevelDB/classic-level local KV index, whole-array index snapshots, LWW-by-default event propagation, optional CRDT merges, and time/mutation-based snapshot schedules. The **later agreed design** in this conversation instead prioritizes recursive individually addressable JSON index nodes and a filesystem-backed reference implementation. Do not silently replace this with LevelDB or a monolithic `_index_snapshot.bin`. Snapshotting, LWW, CRDT, and pub/sub can be reconsidered as optional capabilities in later phases.

## 10. Durability, concurrency, and correctness risks

These issues are **not solved by the prototype** and must be addressed before calling CoCreateDB a distributed production database:

1. **Multi-node atomicity:** Splitting a leaf updates existing node, new sibling, parent, and possibly catalog. Individual atomic renames do not commit them as a unit. Need a publish/commit protocol, versioned immutable nodes, manifest pointer swap, WAL/journal, or equivalent.
2. **Concurrent writers:** Two servers modifying the same root can lose writes. Need concurrency control (single-writer lease, CAS/version checks, optimistic retries, consensus/quorum, or other explicit model).
3. **Object/index consistency:** Object write success and index write failure (or vice versa) creates inconsistency. Define ordering, recovery, and idempotency.
4. **Cache coherence:** Active subscribers can receive updates, but dormant disk copies intentionally stop receiving them. A returning subscriber must refresh or catch up before serving the dormant copy; the version/checkpoint protocol is unresolved.
5. **Uniqueness:** ObjectId generation reduces collision risk but does not itself enforce uniqueness across distributed writers.
6. **Read consistency:** Reads are eventually consistent and use available values; they do not coordinate a tree snapshot. Subscription delivery and stale-copy refresh still require end-to-end verification.
7. **Crash recovery:** Interrupted writes and orphaned nodes require detection and repair/garbage collection.
8. **Type semantics:** The prototype has explicit boolean and null branches, recursively indexes nested object leaves, and indexes array scalar values by field path. Missing values have no entry; date encoding, empty composite values, non-finite numbers, geospatial queries, and locale-sensitive string ordering need explicit contracts.
9. **Byte limits:** Serialized JSON size and provider limits differ; splitting must account for metadata overhead and unsplittable entries.
10. **Cost model:** Cheap bytes do not imply cheap request counts; index depth, GET/PUT latency, amplification, and cache hit rate need benchmarks.

A practical first milestone can deliberately be **single-process/single-writer**, with these limitations prominently documented.

## 11. Initial prototype status

The repository contains a filesystem-backed ESM index plus a `createDB({ directory })` factory exposing `send()` for database, array, and object CRUD. Database/array name catalogs resolve to stable IDs; object payloads and indexes use flat UUID-addressed files. The recursive Distribution Index maps regular index partition paths to holder nodes. The Cluster adapter acquires missing partitions over targeted requests and sends changed partition contents to current holders; the older entity availability map remains for exact-ID metadata/document acquisition. Create indexes `_id` and supported field values independently; equality queries intersect candidates and range queries scan indexed type branches using shared JavaScript relational semantics. Indexes support number, string, boolean, null, and terminal array branches. Ordinary objects flatten to dot paths; full array values are stored whole in flat value files so array positions and nested members do not create independent index entries. Array object lengths are indexed in their parent database catalog and checked against `_id` roots; catalog `catalogLength` tracks mappings, and node lengths track subtree entries. An in-memory Map cache is opt-in.

The Node tests cover index traversal and mutation, CRUD/catalog identities, shared operators, projections, demand-loaded peer data, holder-targeted propagation, local/peer inventory separation, disk-disabled operation, snapshot replacement and revision handling, disconnect/reconnect lifecycle, and restart under a new server ID. These are isolated tests. They do not establish multi-file transaction safety, crash recovery, real-network durability, workflow persistence fallback or complete user-subscription cleanup. Terminal-array transfer has isolated peer coverage. Existing rollback/write-behind baseline failures remain unresolved.

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
| Split | **Decided** | Outgoing serialization triggers positional ~50/50 splits at the preferred byte target |
| Rebalancing | **Decided** | No mandatory neighboring redistribution; optional compaction |
| First adapter | **Decided** | Node.js filesystem; optional Map cache |
| Local object/index cache lifecycle | **Decided direction** | Apply one demand-based policy to all objects and indexes; stop syncing and remove local copies after the last local subscriber leaves, with optional shared-disk debounce |
| Retention overrides | **Future configurable option** | Object/array metadata may opt into retention or continued subscription after core behavior is stable |
| Dormant-copy freshness protocol | **Open** | If cleanup is delayed, define version/checkpoint validation or refresh-on-resubscribe |
| Index update semantics | **Deferred** | CRUD names are implemented; update currently aliases entry insertion |
| Catalog scalability | **Prototype implemented** | Bounded recursive catalog tree with a stable ID-addressed root; same byte limit as field nodes |
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
`Index.locatePartitions` memoizes live node/catalog references within a pass and
returns unique partition paths; it does not copy the nodes.
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
fresh query results after an index-blocked update, split-catalog partition lookup,
retained holders, and live cache references.

### Staged primary acknowledgments — implemented

Read/delete use the same response-first contract. Reads use the values available
during execution and return after query evaluation, sorting, pagination, and
projection. They do not wait for pending index jobs or later changes to establish
a snapshot. Acquired values enter memory; availability claims, cache bookkeeping,
and recovery indexing follow as backend work. Subsequent subscribed events carry
later changes. Deletes acknowledge removing the owned memory value and setting an
in-memory lifetime guard; persisted tombstones and index cleanup follow afterward.
Neither lifecycle rewrites an already completed response if backend work fails.

The response boundary is the owned in-memory value in default server write-behind
mode. Object creates enqueue counters and local availability; updates retain their
old index entries before mutation and enqueue reconciliation immediately after the
memory commit, without scanning the resulting document on the response path.
Namespace resolution/creation still establishes where the document belongs.
Client registration messages and peer delivery run afterward. Backend failures are
reported internally and never rewrite the completed success response.

Peer dispatch runs in a separate sequential queue, preserving holder-targeted
delivery before disk persistence without holding subsequent memory CRUD behind
network waits. Encoding-triggered structural splits re-enter the primary queue
for mutation only. Explicit `flush` drains indexing, delivery, then disk writes,
including work queued while an earlier delivery was blocked. Explicit write-through
mode remains synchronous for local tools. The live-reference contract below also
applies to indexing and persistence.

The primary applies document create/update/delete in memory and responds through
existing CRUD/IPC. Shared Utils `createUpdate` remains the update engine. Catalog
metadata is immediately indexed in memory. Payload indexing runs afterward on
the same primary operation queue. While payload indexes lag, queries union their
index candidates with pending object IDs, load the current memory record, omit
pending deletions, and verify the complete query before filtering/pagination.
Thus filtered reads, updates, and deletes do not depend on stale indexes alone.

A pending index entry identifies database/array/object, retains the previous
index entries, and tracks a monotonically increasing per-process document revision.
Repeated updates coalesce to the latest memory value. Reconciliation mutates live
nodes. A failure retains pending work for retry; it does not restore partially
changed nodes or provide rollback. Completed holder-targeted changes dispatch
through Mesh, and `db.indexed` goes through existing IPC to local workers. Local
workers retain no independent DB engine. Disk writes do not gate these messages.

All JSON writes, chunk writes, and removals use a root-scoped write-behind adapter.
Its sequential queue stores addresses, operations, and revisions, resolving the
current cached JSON only when flushing. The same live value feeds
local serialization and the optional storage callback; no revision snapshot is
made. New revisions arriving during I/O stay dirty; pending paths cannot be evicted. Cached persisted values
remain available until explicit clearing; LRU/byte limits are not implemented.
Persistence has a configurable per-path trailing cooldown (25 ms by default),
with a maximum wait of 1000 ms once indexing is ready. Repeated changes reset the
cooldown within that bound. Indexing/propagation remain immediate, and explicit
flush bypasses cooldown. Dirty entries remain pinned through all required acks.

The low-level persistence queue can require a supplied storage callback after disk
completion. The server's retained `storageWorkflow` hook remains disconnected by
the external-write feature gate; configuring its name alone does not enable it.
No workflow implementation is seeded here. `flush` drains indexing, delivery,
and persistence; `close` drains and unregisters the adapter. The server registers
it for graceful shutdown. Draining requires
quiescence to establish a final boundary. Automatic retries remain process-local.
A failed index entry conservatively gates persistence across its root because
catalog/index files are shared. A process crash can lose acknowledged revisions;
Mesh dispatch alone does not establish durable replica storage or multi-node
commit. Crash recovery, durable retry journals, and cross-server conflicts remain
open. Standalone DB callers retain write-through behavior by default.

Deletion records a `deleted/<deletionId>.json` lifetime marker containing the old
`created.on`. Its ID hashes the logical database, array, and object ID. It persists
independently of the removed payload.
The marker rejects normal updates to missing/deleted IDs and stale peer copies.
Explicit recreation/upsert creates a new, locally monotonic creation timestamp,
clears the marker, and indexes the new lifetime. Replicated stale sets/deletes
are checked against the marker/current lifetime before application. Ordinary
updates cannot alter `created.on`. ID-only requests cannot distinguish old and
new lifetimes after intentional ID reuse; callers must include the creation date
for that check. Creation timestamps are not a complete distributed version clock.
Marker retention/purge and cross-server causal ordering remain open policies.

### Update patches and resulting state — implemented server contract

Object updates accept `$update` on an object or the request envelope, with the
per-object patch taking precedence. Supplied patches are reused as-is. Without
one, DB builds a patch from the original fields and operators using shared update
syntax; increment deltas and array operations retain their intent. Undefined
assignments become explicit `$unset` entries in generated patches for transport.
The normal shared `createUpdate` executes against prepared property slots before
attachment; no separate patch-schema validation/correction layer is introduced.
Existing immutable identity and creation-lifetime checks remain in place.

Client replies and `db.indexed` worker notifications contain the complete result
plus `$update`. Holder-targeted update mutations carry `_id`, `$update` and audit
metadata, without a full object. Delivery views do not attach patches to owned
records. Documents persisted locally or through persistence hooks remain complete
records without transport patches. Creates and recreated-lifetime upserts still
publish full `set` snapshots.

Deferred indexing coalesces work by object address but retains each original
patch for propagation. Receivers apply a patch to their existing local document,
then persist the full result without originating the mutation again. Missing-base
receivers fetch a current full snapshot from the publisher and do not replay the
already-included patch. Index partitions retain their existing separate delivery
path. Peer-to-worker notifications retain the received patch alongside local state.

This stage does not update browser adapters, optimistic acknowledgment handling,
operation ordering, deduplication/recovery, or field-level conflict resolution.
Document deletion/lifetime checks and external persistence hooks are unchanged.

### Organization-owned logical storage hierarchy — implemented

The public DB service now requires `organization_id`, logical `storage`, and
`database` in every request. CRUD imports DB directly (using the server's primary
engine/worker proxy when provided), resolves hostname defaults, then fills absent
storage/database as `production` / `app`. CRUD leaves array unchanged, including
absence, and performs no provider selection. Its organization registry queries
use explicit production/app scope and `host: null` to prevent host-default
recursion without array-specific routing. The configured organization can
bootstrap via local CRUD before any organization/key records exist.

The root path is `<root>/<organization_id>/root.json`; all record and index files
are organization-level siblings as described in section 3. Storage-name catalogs
and metadata use the same record/index primitives as lower tiers. Storage rename
preserves UUIDs and descendants; metadata/deletion events carry physical file IDs.

The scoped service lazily creates engines for logical namespaces, sharing the
organization's JSON cache, partition inventory, and write-behind persistence queue.
The independently testable object engine uses the same flat record layout, with a
standalone root pointing directly to its database catalog. Scoped engines defer
root ownership to their organization. Namespace creation is serialized locally.
Global cross-server creation/name conflicts still need distributed coordination;
conflicting stable IDs fail instead of silently aliasing separate namespaces.

Entity references and peer fetches carry organization/storage IDs. Index partition
addresses include only organization and index UUID. Mesh carries tenant identity in a nested scope
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
and never go to socket clients. Client registration messages for write-behind CRUD
follow the memory/query acknowledgment and do not hold the primary request queue.
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

### Live-reference core — current contract

Request resolution retains already-resolved names, IDs, and live record references
in a temporary async context. Scope routing, CRUD, metadata counters, distribution,
peer publishing, and persistence recovery share that context. The holder uses plain
objects/arrays, not copied datasets or a persisted joined-name index. Independent
server operations start fresh contexts. Pending index entries retain their current
request context through completion; normal record/cache references can outlive it.
Record creation/update/deletion refresh or invalidate request aliases, including
renames and ID recreation. Missing records are not negatively cached, so acquisition
and creation can resolve them later in the same operation.

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
Update replies expose a result view plus the original patch. Queued propagation
retains each patch and its operation operands rather than diffing final state.
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

The local disk and persistence staging paths retain the same live values until
the encoding boundary. External workflow writes remain disabled; removing the
old defensive snapshot does not establish external durability or transactions.
IPC and network serialization necessarily construct values in another process.

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

Terminal arrays are retained whole in memory and written as `values/<id>.json`. They are data, not index partitions.
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

Persistence responses accept already parsed values or JSON strings. String file
values are parsed once and retain their observed UTF-8 size as `$bytes`; object
values keep their references without size-only encoding. Outer response-envelope
bytes are not assigned to contained files. Parse failures accumulate a safe message
in the requesting envelope's `error` array and prevent recovery installation.
The byte observation survives record hydration, is excluded from automatic indexes
and ordinary patch generation, and may be older than current contents. This does
not enable the disconnected workflow file-tree read or external write paths.

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

### Flat file addressing — implemented

Catalog and field partitions share `<organization_id>/indexes/<id>.json`. Roots
use stable hashes of organization-relative logical namespace addresses; child
partitions retain UUID-derived IDs. Every node identifies its catalog, whose root
records the virtual namespace path for cold split ancestry. No physical catalog
directory or global record map is required.

`root.json` is exchanged in connection inventories and announced on creation.
Peers acquire catalogs, metadata records, object records, and terminal-array value
files on demand. Parsed transport values become local live references; acquired
files are saved locally when disk is enabled. Physical file UUIDs travel with peer
requests, responses, and mutations. Peer updates still carry `$update`; clients
receive the resolved record plus patch. Complete records are stored locally.

Deletion follows the affected catalogs and file references, never the whole shared
indexes directory. Local distribution retains its separate internal layout and
follows `disk`; peer inventory stays in memory. Existing datasets and old peer wire
formats require coordinated migration; none is performed automatically.
