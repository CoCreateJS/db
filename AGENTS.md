# CoCreateDB — Codex Project Instructions

> Repository: `CoCreateJS/db` · npm: `@cocreate/db` · Product/documentation name: **CoCreateDB**
>
> This file records agreed architecture and coding guidance for AI contributors. Read [ARCHITECTURE.md](./ARCHITECTURE.md) before modifying the indexing engine. Distinguish **decided**, **prototype**, and **proposed** behavior; do not silently promote proposals to commitments.

## Mission

Build a lightweight, JavaScript-native, storage-agnostic NoSQL document database engine. Data objects can live in filesystem directories, cloud object stores (S3, Google Cloud Storage, Azure Blob Storage), or future adapters. CoCreateDB owns logical organization, indexes, queries, and eventually storage orchestration. The recursive index is a public, independently usable primitive, not the entire product.

## Canonical identity

- GitHub organization/repository: `CoCreateJS/db`.
- npm package: `@cocreate/db` (lowercase).
- README, documentation, and product title: `CoCreateDB`.
- Company: **CoCreate**; wider JavaScript project: **CoCreateJS**; components include **CoCreate Client** and **CoCreate Server**.
- Target: JavaScript ESM, Node.js-first. Keep standalone use possible; do not force an import of all of CoCreate Server to use the DB/index primitive.
- Prefer `primary` / `worker` terminology rather than `master` / `worker`.

## Vocabulary — preserve across APIs and code

| Term | Meaning |
|---|---|
| `database` | Logical namespace |
| `array` | Logical dataset (not necessarily a physically stored JS array) |
| `object` | Data object or CRUD target; disambiguate identifier as `objectId` internally |
| `key` | JS object property, including nested dot-notation paths |
| `value` | Value of an indexed key |
| `index` | Sorted mapping or recursive index node |
| `first`, `last` | Actual first/last ordered `(value, objectId)` boundaries |
| `length` | Available indexed entries or objects; `catalogLength` tracks key/type mappings; database metadata uses `arrayLength` and `objectLength` |
| `count` | Matching query results, preserved in source response metadata |

Do not rename the core API to `collection`, `field`, `column`, or `row`. External database adapters may translate those terms. Default enumeration uses the `_id` key, ordered by ObjectId; this is **not a guarantee of strict global insertion chronology** across distributed nodes.

## Architecture invariants (decided)

- Distribution has two lifecycles: `distribution.local` belongs to this node and
  follows `db.disk` (default true); `distribution.peers` excludes this node and is
  memory only. Never send received peer inventories through filesystem indexes
  or persistence. Control connections exchange local snapshots once in each
  direction, then incremental changes. Disconnect removes that peer's contribution.

1. **Logical root address:** `database + array + key`; e.g. `Index.read('production', 'users', 'age')`. Resolve logical database and array names through recursive name catalogs to stable IDs, then resolve the key root through the array field catalog. Do **not** expose internal IDs as the only public addressing mechanism.
2. **Array field catalog:** A recursive ordered tree mapping `(key, type)` to index roots. Each mapping stores `[key, type, rootId, { length, first, last }]`, refreshed on every branch mutation. Legacy three-item mappings and structural `count` fields remain readable; touched nodes use length names. `Index.getMetadata()` exposes these summaries without fetching value roots for upgraded entries. `index.json` is its stable root; replication serialization measures the node against the preferred byte target. Overflow moves entries into 32-character hexadecimal child nodes and can add levels as needed.
3. **Internal nodes:** independently addressable by unique, opaque IDs; parent references include child `id`, `first`, `last`, and `length`. Nodes can recursively reference nodes. No need to rename existing IDs during splits.
4. **Types and automatic indexes:** the current prototype stores finite `number`, `string`, `boolean`, and explicit `null` values in separate branches. Automatically maintain an independent index for each supported field path on object creation; do not create compound indexes for ordinary field queries. Nested object leaves use dot paths, and array scalar values use their field path. Missing and unsupported composite values require explicit semantics; don't silently discard them in production.
5. **Ordering:** entries sorted by `(value, objectId)` so equal values are deterministic and duplicate values across objects are supported. `first`/`last` are complete entry boundaries, not alphabetical buckets or just first letters.
6. **Local splits:** mutations insert/update live nodes without measuring bytes or splitting. Only replication serialization can trigger a split: encode a node once; if it exceeds the preferred size, split that **one** node approximately 50/50 by position when useful, update ancestors, then encode/send the changed nodes. Keep indivisible entries and minimum two-child internal nodes valid above the target. Preserve old node ID, create one sibling ID, update parent, recursively split parent if needed. Do not rebalance neighboring nodes or fetch unrelated descendants.
7. **Cleanup:** delete empty nodes, propagate metadata upward, collapse redundant roots where safe. Merging partially occupied siblings is optional future maintenance, not required in the write path.
8. **Storage isolation:** logical `Index.read()`/`Index.create()` entry points hide retrieval/persistence. Once a root is resolved, traversal can fetch child nodes directly by ID via internal node I/O, without repeatedly resolving the logical key. Filesystem-backed implementation is the initial reference; memory Map is an optional cache, **not** the sole persistence design.
9. **On-demand:** never load a whole array or whole index tree merely to process a query. Fetch only required catalog, key roots, child nodes, and matched objects. Stream/cursor where appropriate. Memory usage is a primary optimization constraint.
10. **Index every key:** on object creation/update, extract dot-notation keys and maintain indexes for all indexed values; on update, remove old `(value, objectId)` entries and add new; on deletion, remove entries. The `_id` enumeration index must be maintained even with no user query keys.
11. **Entity catalogs:** recursively index logical database names and per-database array names to stable 24-character ObjectIds from `@cocreate/utils`. Keep metadata/configuration in JSON under those IDs; rename changes catalog entries and metadata without moving descendants. Database, array, and object records share the same create/read/update/delete processor, which indexes metadata fields as well as payload fields. Array and database counters are ordinary metadata values maintained through that contract.
12. **Independent primitive:** keep `Index` importable/usable separately from higher-level CoCreateDB CRUD/query/storage orchestration.

## API direction

The **logical API** uses `Index.create`, `Index.read`, `Index.update`, and `Index.delete`. Reads take `(database, array, key = '_id')`; entry mutations take `(database, array, key, value, objectId)`. Create and update currently both perform the previous entry insertion operation. Delete removes a matching entry. Replacing a value still requires deleting the old entry first; further index semantics are deferred. CRUD envelopes use one handler with the same method names and `index: [{ key, value, objectId }]`. Do not confuse entry mutations with whole-partition replacement. `Index.read()` should return a predictable shape; missing data and storage failures must be distinguishable.

Recommended separation (names provisional):

```js
// Public logical entry point
await Index.read(database, array, key)

// Internals, not necessarily public
await getCatalog(database, array)
await getNode(database, array, nodeId)
await setNode(database, array, node)
```

Keep I/O asynchronous even when memory-backed. Make adapters replaceable without changing indexing algorithms. Avoid repeated root resolution during recursion.

## Filesystem reference layout (provisional)

```text
<storage-root>/databases/index/                 # database name -> database ID
<storage-root>/databases/<database-id>/
  database.json
  arrays/index/                                  # array name -> array ID
  arrays/<array-id>/
    array.json
    index/                                        # field/type -> index roots
    objects/<object-id>.json
```

Store database and array names in catalogs. Use shared `ObjectId()` values (24-character hexadecimal) for databases, arrays, and objects; use shared `uuid()` values without hyphens (32-character hexadecimal) for internal index nodes. Validate IDs and node references. Node JSON must be data only; do not import/execute `.js` data files. JSON was preferred over executable JavaScript because it parses efficiently, avoids side effects on reads, supports controlled cache lifetime, and matches existing serialized data transport. Use atomic file replacement where possible, but recognize that rename alone is **not** a multi-file transaction.

## Index node shape (illustrative, not frozen schema)

```js
// Catalog root/leaf (length = objects, catalogLength = catalog mappings)
{ id: 'root', kind: 'catalog', length: 1000000, catalogLength: 2,
  entries: [['_id', 'string', 'id-root', { length: 1000000, first: {}, last: {} }],
            ['age', 'number', 'age-root', { length: 1000000, first: {}, last: {} }]] }

// Once this root exceeds maxBytes, its entries are split into 32-character hexadecimal files;
// index.json stays the root and points to bounded child nodes.
{ id: 'root', kind: 'catalog', length: 1000000, catalogLength: 2,
  indexes: [{ id: 'uuid', length: 1, first: ['_id', 'string'], last: ['_id', 'string'] },
            { id: 'uuid-2', length: 1, first: ['age', 'number'], last: ['age', 'number'] }] }

// Internal node
{ id: 'node-id', length: 2500,
  first: { value: 18, objectId: '...' },
  last: { value: 35, objectId: '...' },
  indexes: [{ id: 'child-id', length: 2500, first: {}, last: {} }] }

// Leaf
{ id: 'leaf-id', length: 2,
  first: { value: 18, objectId: '001' },
  last: { value: 22, objectId: '002' },
  entries: [[18, '001'], [22, '002']] }
```

Never interpret `{ first: {}, last: {} }` as valid runtime boundaries; these placeholders are schematic only.

## Engineering style

- ESM, plain JavaScript; prefer small composable functions, minimal dependencies, and clear interfaces.
- DB runtime errors accumulate in `data.error` arrays through local error handlers; preserve earlier entries. Do not console-log DB API failures. Delivery failures after acknowledgment remain visible in `persistenceStats().backgroundError`.
- Favor native JS concepts and concise loops (`for` loops are preferred where practical). Avoid unnecessary variables/abstraction and heavyweight frameworks.
- Preserve CoCreate's existing `array`/`object`/`key`/`index` conventions and dot-notation behavior. Do not invent incompatible CRUD syntax.
- Treat numeric/string comparisons, duplicate values, deleted keys, and root transitions as correctness-critical.
- Measure an index node only from the encoding already prepared for replication; reuse that encoding in Mesh when no split is needed. No entry-count split trigger and no byte-weight serialization during mutation. Treat node byte size as a preferred target; allow indivisible entries and minimum-fanout internal nodes to exceed it without errors or retry loops.
- Keep storage-specific details and AST workflow evaluation out of the hot index traversal path.
- When changing node structure, update fixtures/tests and ARCHITECTURE.md together.

## Required test coverage

- Ordered insert/search/scan (forward/reverse), deterministic equal-value tie-breaking, duplicate insertion idempotence.
- Separate string, number, boolean, and null branches; numeric ordering; `_id` enumeration and automatic per-field object indexes.
- Insert at beginning/middle/end; byte-limit overflow and recursive leaf/internal/root splits; preserve IDs and ordered child ranges.
- `first`, `last`, `length` correctness at every level after insert/delete; empty-node pruning and root collapse.
- Updates changing/removing/adding nested keys; no stale index entries.
- On-demand node fetches, cache invalidation, bounded memory, restart from persisted files.
- Missing/corrupt files, malformed paths, oversized single entries, failed writes, and interrupted multi-node updates.
- Standalone multi-writer conflicts are **not solved** by the current prototype. The `@cocreate/cluster` integration serializes writes through its primary; cross-server write coordination and crash recovery remain unsupported.

## Implementation status and priorities

**Current implementation:** the repository has a filesystem-backed index and `createDB({ directory })` with recursive database/array name catalogs, stable IDs, and database/array/object CRUD. A recursive Distribution Index maps regular index partition paths to holder node IDs. Partition files are acquired on demand over targeted Cluster requests; updated index-node JSON is sent only to current holders, while holder changes are propagated through Cluster. CoCreateDB initializes from the Cluster server object as `server.db`, owns directory configuration, and routes worker CRUD reads and writes through the primary. CRUD uses the DB service after organization/host routing. A legacy database/array/object availability index remains for exact-ID metadata/document acquisition. Arrays are terminal index values stored whole outside index nodes; legacy bounded-array encodings remain readable; object properties still use dot-notation paths. **Do not mistake this for production-ready replication:** initial partition-map snapshot/bootstrap, local holder reconstruction, chunked array-value transfer, external persistence fallback, document synchronization, multi-file transactions, cross-server write coordination, and crash recovery remain unimplemented. Partition event retry/replay follows the Cluster delivery contract.

**Next priorities:** (1) bootstrap a clean node's partition map from the first initialized Mesh node and rebuild local holders after restart; (2) add external storage fallback for regular index/document files; (3) transfer bounded terminal-array value chunks; (4) replace legacy entity-location lookup with index-trail resolution; (5) decide whether optional message signing adds useful defense in depth; (6) harden partial-failure behavior and benchmark memory, I/O, and write amplification.

## Future direction — proposed, not finalized

- Object payloads in FS/S3/GCS/Azure and other storage adapters; optional multi-destination reads/writes.
- CoCreate AST workflows may orchestrate storage selection, fan-out, fallback, quorum, or replication **at operation/policy level**, not necessarily per hot-path node access.
- Partition availability events, on-demand partition fetch, and holder-targeted regular-index updates are implemented over the existing Cluster mesh. Initial snapshots, terminal-array chunk acquisition, external storage fallback, and index/document commit semantics remain open. Event retry/replay relies on Cluster.
- Cloud object stores provide durability/replication features, but do not automatically provide multi-object transactions or database-level consistency.

## Codex working protocol

1. Read this file and ARCHITECTURE.md before implementing.
2. Identify which behavior is **decided**, **prototype**, or **proposed**.
3. Keep existing public naming, index invariants, and lightweight design unless explicitly asked to change them.
4. For ambiguities (notably `Index.create`, type semantics, and commit protocol), surface the tradeoff and propose the smallest consistent solution rather than silently deciding. Catalog scaling currently uses a bounded recursive tree rooted at `index.json`.
5. Make incremental changes with executable tests; report what was tested and what remains unsupported.


### Write-path tuning and primary-only engine

Index reads share live nodes with the cache. The optional index cache retains
those same references. Bulk partition lookup memoizes addresses within a pass;
it does not copy catalog or data nodes. Standalone operations with no
mutation publisher skip holder discovery; distributed operations retain all old
and new holders, including subscribers to unchanged fields.

Workers instantiate only an IPC `send()` driver, without an engine/cache or peer
listeners. Worker CRUD reads use the same primary-owned database/cache as writes and
wait behind the primary request queue. This prevents independently cached worker
catalogs/documents from hiding completed primary writes. It adds one IPC request
for a worker CRUD read; cross-server replication remains a separate contract.
Server-integrated object CRUD acknowledges the applied memory revision before
background indexing and persistence. Queries supplement index candidates with
pending documents and verify their current values. Index reconciliation, holder
propagation, and sequential write-behind persistence have separate progress.
Standalone `createDB()` retains write-through behavior unless `writeBehind` is
explicitly enabled. No multi-file crash-atomic transaction was added.

### Staged primary writes — implemented

The primary defaults to `writeBehind: true`. Object create/update/delete publishes
the document state to memory, then schedules index reconciliation by stable
object path. Queue entries coalesce revisions; the previously indexed record is
retained for removing old entries. Pending documents supplement every object
query, including filtered updates and deletes. An in-memory index checkpoint
restores partial node changes if reconciliation fails; retries retain the pending
document. Catalog metadata stays immediately indexed in memory.

After successful indexing, holder-targeted index/document Mesh messages and a
`db.indexed` IPC notification to workers are dispatched before disk persistence.
Disk writes/removals share one sequential address/revision queue, resolving the
latest immutable memory value at flush time. New updates during I/O remain dirty.
Dirty paths are pinned against cache clearing. Retain clean payloads as cache;
there is no automatic LRU limit yet. Optional required storage acknowledgment is
configured by `storageWorkflow` / `COCREATE_DB_STORAGE_WORKFLOW`, invoked through
`server.workflow.run(...)`. No workflow is seeded here.

`db.flush()` drains indexing and currently eligible persistence; `db.close()` also
unregisters the write-behind adapter. Primary shutdown registers a close handler.
Automatic indexing/persistence retries are in memory, not a durable journal.
An acknowledged memory write can be lost on a crash before persistence; Mesh
send does not establish durable replica acknowledgment. A failed index revision
conservatively gates persistence for the root because catalogs/nodes are shared.

Persistence cooldown defaults to 25 ms per path, bounded by a 1000 ms maximum wait
once indexing is eligible; configure both through `persistenceOptions`. Flush and
shutdown drain bypass cooldown. Do not debounce index processing or propagation.
Deletion lifetime markers persist under `deleted/<objectId>.json`. Keep them until
an explicit recreation/upsert establishes a fresh creation date; ordinary updates
cannot change `created.on`. ID-only updates cannot identify an old lifetime after
intentional ID reuse; timestamps do not replace distributed version coordination.

Object updates use `$update` as the mutation patch. Reuse a supplied per-object
or envelope patch as-is; otherwise generate it from the request fields/operators.
Do not add a patch-schema validation/correction layer. Execute through existing
Utils `createUpdate` with the existing document identity/lifetime invariants.
Client responses include the resulting record plus `$update`; peers receive
`_id`, `$update` and audit metadata. The patch stays in delivery, never on the
owned/persisted record. Peer application merges into its local document without
originating the operation again. Missing-base acquisition fetches a current full
snapshot and does not replay an already-included increment over it. Keep each
pending patch when coalescing index work so increments/appends are not lost.
Client adapters, operation ordering, deduplication/recovery and field-conflict
policies are separate work; no new guarantees in those areas are implied.

### Required public namespace hierarchy

The public createDB service requires explicit organization_id (24 hex), storage,
and database. Defaults belong only to CRUD: hostname defaults fill missing values,
then production/app. Array is forwarded untouched. CRUD uses `server.db` after
organization/host routing; do not resolve the persistence directory or construct
a DB in CRUD, and do not call GetDriver for this dispatch.

Store data under <root>/<organization_id>/storages/<stable-storage-id>/databases/...
with a recursive storage-name catalog at <organization_id>/storages/index.
Storage rename changes references/metadata, never descendant directories. Keep
provider selection and persistence endpoint design separate for a later task.
The relative object/index engine is internal and remains independently testable.
Distribution tuples require organization/storage IDs and partition paths require
the full prefix. Put organization identity inside scope on DB Mesh control events.
Use a shared root persistence queue across namespaces. Existing datasets are left
for the user's reset and bootstrap; do not infer or perform a legacy migration.

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

Persistence redesign and provider snapshot semantics are out of scope for this
phase. `src/persistence.js` is unchanged from the checkpoint; its existing external
storage snapshot hook is not part of the no-clone, memory-only validation. Existing
persistent-mode examples must not be taken as proof of durability/rollback under
this new live-reference contract. IPC and real-network serialization inherently
construct data in another process; this contract removes DB-side defensive copies.

### Replication-time splitting and local byte accounting — current contract

Only an outgoing index-node encoding can trigger a structural split. The default
preferred target stays 128 KiB. Mutations never measure node bytes or split by
entry count. Split arrays at their positional midpoint; do not serialize each
entry for byte balancing. Preserve original nodes, create siblings, update all
ancestor/catalog references, and send the resulting live nodes to affected holders.
A leaf with one entry or an internal node with fewer than four children is not
usefully splittable; send it above target without an error/retry loop. The threshold
measures the encoded index node, excluding the transport routing envelope.
Whole document payloads and terminal-array values are not structurally split.
Standalone indexes without replication can therefore grow above target.

Capture successful local JSON-file byte lengths from the existing disk-write
encoding. Keep the mapping in a local `.bytes` sidecar in each directory, keyed by
filename; never add it to documents, indexes, Mesh data, or subscription metadata.
Write-behind batches sidecar changes per directory at the end of its persistence
pass. Deletions remove entries. This records last-persisted UTF-8 JSON bytes,
excluding sidecar overhead, not heap use, pending memory revisions, compressed or
allocated disk blocks. Existing files are not scanned/backfilled automatically.
Custom persistence writers own their byte accounting. No size telemetry timer or
global aggregate is introduced. Index splitting never reads these sidecars.

### Legacy provider recovery is not tree persistence

`db.externalPersistence: true` opts into legacy **object reads only** for recovery.
It defaults off; `db.persistence: false` or `memoryOnly: true` also disables it.
External create/update/delete and external workflow writes remain disabled. MongoDB
is a temporary source of legacy records, not a persistence adapter for the tree.

On a local/peer read miss, the provider receives an unprojected query without
source-document metadata or resolved update patches. Complete returned records
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
