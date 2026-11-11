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
| `count` | Field-catalog root count tracks indexed entries; array metadata `count` tracks objects; database metadata `count` tracks arrays and `objectCount` tracks objects |

Do not rename the core API to `collection`, `field`, `column`, or `row`. External database adapters may translate those terms. Default enumeration uses the `_id` key, ordered by ObjectId; this is **not a guarantee of strict global insertion chronology** across distributed nodes.

## Architecture invariants (decided)

1. **Logical root address:** `database + array + key`; e.g. `Index.get('production', 'users', 'age')`. Resolve logical database and array names through recursive name catalogs to stable IDs, then resolve the key root through the array field catalog. Do **not** expose internal IDs as the only public addressing mechanism.
2. **Array field catalog:** a recursive ordered tree mapping `(key, type)` to index roots. `index.json` is its stable root and is measured against the same byte limit; overflow moves entries into 32-character hexadecimal child nodes and can add levels as needed.
3. **Internal nodes:** independently addressable by unique, opaque IDs; parent references include child `id`, `first`, `last`, and `count`. Nodes can recursively reference nodes. No need to rename existing IDs during splits.
4. **Types and automatic indexes:** the current prototype stores finite `number`, `string`, `boolean`, and explicit `null` values in separate branches. Automatically maintain an independent index for each supported field path on object creation; do not create compound indexes for ordinary field queries. Nested object leaves use dot paths, and array scalar values use their field path. Missing and unsupported composite values require explicit semantics; don't silently discard them in production.
5. **Ordering:** entries sorted by `(value, objectId)` so equal values are deterministic and duplicate values across objects are supported. `first`/`last` are complete entry boundaries, not alphabetical buckets or just first letters.
6. **Local splits:** positional insert first; on exceeding serialized byte-size limit, split that **one** leaf or internal node approximately 50/50, preferably by byte weight. Preserve old node ID, create one sibling ID, update parent, recursively split parent if needed. Do not rebalance neighboring nodes or fetch unrelated descendants.
7. **Cleanup:** delete empty nodes, propagate metadata upward, collapse redundant roots where safe. Merging partially occupied siblings is optional future maintenance, not required in the write path.
8. **Storage isolation:** logical `Index.get()`/`Index.set()` entry points hide retrieval/persistence. Once a root is resolved, traversal can fetch child nodes directly by ID via internal node I/O, without repeatedly resolving the logical key. Filesystem-backed implementation is the initial reference; memory Map is an optional cache, **not** the sole persistence design.
9. **On-demand:** never load a whole array or whole index tree merely to process a query. Fetch only required catalog, key roots, child nodes, and matched objects. Stream/cursor where appropriate. Memory usage is a primary optimization constraint.
10. **Index every key:** on object creation/update, extract dot-notation keys and maintain indexes for all indexed values; on update, remove old `(value, objectId)` entries and add new; on deletion, remove entries. The `_id` enumeration index must be maintained even with no user query keys.
11. **Entity catalogs:** recursively index logical database names and per-database array names to stable 24-character ObjectIds from `@cocreate/utils`. Keep metadata/configuration in JSON under those IDs; rename changes catalog entries and metadata without moving descendants. Database, array, and object records share the same create/read/update/delete processor, which indexes metadata fields as well as payload fields. Array and database counters are ordinary metadata values maintained through that contract.
12. **Independent primitive:** keep `Index` importable/usable separately from higher-level CoCreateDB CRUD/query/storage orchestration.

## API direction

The **logical API** is `Index.get(database, array, key = '_id')` and `Index.set(database, array, key, ...)`. **The exact `set` payload/signature is not finalized**: the prototype treats `set` as entry insertion, while discussion also uses it for persisting a root. Do not assume those meanings are interchangeable. Propose and document a clear distinction between logical entry mutations, root/catalog updates, and internal node writes before stabilizing the public API. `Index.get()` should return a predictable, validated shape; missing data and storage failures must be distinguishable.

Recommended separation (names provisional):

```js
// Public logical entry point
await Index.get(database, array, key)

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
// Catalog root/leaf (count = objects, catalogCount = catalog mappings)
{ id: 'root', kind: 'catalog', count: 1000000, catalogCount: 2,
  entries: [['_id', 'string', 'id-root'], ['age', 'number', 'age-root']] }

// Once this root exceeds maxBytes, its entries are split into 32-character hexadecimal files;
// index.json stays the root and points to bounded child nodes.
{ id: 'root', kind: 'catalog', count: 1000000, catalogCount: 2,
  indexes: [{ id: 'uuid', count: 1, first: ['_id', 'string'], last: ['_id', 'string'] },
            { id: 'uuid-2', count: 1, first: ['age', 'number'], last: ['age', 'number'] }] }

// Internal node
{ id: 'node-id', count: 2500,
  first: { value: 18, objectId: '...' },
  last: { value: 35, objectId: '...' },
  indexes: [{ id: 'child-id', count: 2500, first: {}, last: {} }] }

// Leaf
{ id: 'leaf-id', count: 2,
  first: { value: 18, objectId: '001' },
  last: { value: 22, objectId: '002' },
  entries: [[18, '001'], [22, '002']] }
```

Never interpret `{ first: {}, last: {} }` as valid runtime boundaries; these placeholders are schematic only.

## Engineering style

- ESM, plain JavaScript; prefer small composable functions, minimal dependencies, and clear interfaces.
- Favor native JS concepts and concise loops (`for` loops are preferred where practical). Avoid unnecessary variables/abstraction and heavyweight frameworks.
- Preserve CoCreate's existing `array`/`object`/`key`/`index` conventions and dot-notation behavior. Do not invent incompatible CRUD syntax.
- Treat numeric/string comparisons, duplicate values, deleted keys, and root transitions as correctness-critical.
- Measure serialized byte sizes; account for JSON metadata overhead. Detect an unsplittable oversized single entry rather than splitting forever.
- Keep storage-specific details and AST workflow evaluation out of the hot index traversal path.
- When changing node structure, update fixtures/tests and ARCHITECTURE.md together.

## Required test coverage

- Ordered insert/search/scan (forward/reverse), deterministic equal-value tie-breaking, duplicate insertion idempotence.
- Separate string, number, boolean, and null branches; numeric ordering; `_id` enumeration and automatic per-field object indexes.
- Insert at beginning/middle/end; byte-limit overflow and recursive leaf/internal/root splits; preserve IDs and ordered child ranges.
- `first`, `last`, `count` correctness at every level after insert/delete; empty-node pruning and root collapse.
- Updates changing/removing/adding nested keys; no stale index entries.
- On-demand node fetches, cache invalidation, bounded memory, restart from persisted files.
- Missing/corrupt files, malformed paths, oversized single entries, failed writes, and interrupted multi-node updates.
- Standalone multi-writer conflicts are **not solved** by the current prototype. The `@cocreate/cluster` integration serializes writes through its primary; cross-server write coordination and crash recovery remain unsupported.

## Implementation status and priorities

**Current implementation:** the repository has a filesystem-backed index and `createDB({ directory })` with recursive database/array name catalogs, stable IDs, and database/array/object CRUD. A Distributed Index uses the same recursive engine in sibling `distributed/` directories at database, array, and object scopes. `@cocreate/cluster` initializes `server.DB`, routes worker writes and availability changes through the primary, and applies remote `db.distributed` events there without worker fan-out or rebroadcast. Local create/delete transitions update availability; updates and reads do not. Array/database deletion preserves nested peer references. **Do not mistake it for production-ready code:** initial Cluster sync, startup reconstruction, missed-event recovery, external storage, multi-file transactions, cross-server write coordination, and crash recovery remain unimplemented.

**Next priorities:** (1) initial availability synchronization and explicit local reconstruction; (2) missed-event recovery and checkpoints; (3) harden CRUD and catalog partial-failure behavior; (4) efficient range/filter/sort/limit/skip cursors using node boundaries; (5) provider-backed storage reads and subscription-driven cleanup. Keep the engine lightweight and benchmark memory, I/O, and write amplification.

## Future direction — proposed, not finalized

- Object payloads in FS/S3/GCS/Azure and other storage adapters; optional multi-destination reads/writes.
- CoCreate AST workflows may orchestrate storage selection, fan-out, fallback, quorum, or replication **at operation/policy level**, not necessarily per hot-path node access.
- Incremental Distributed Index events are implemented over the existing Cluster mesh. Full snapshots, missed-event recovery, data replication, consistency, durability, versioning, replica placement, and commit semantics remain unresolved.
- Cloud object stores provide durability/replication features, but do not automatically provide multi-object transactions or database-level consistency.

## Codex working protocol

1. Read this file and ARCHITECTURE.md before implementing.
2. Identify which behavior is **decided**, **prototype**, or **proposed**.
3. Keep existing public naming, index invariants, and lightweight design unless explicitly asked to change them.
4. For ambiguities (notably `Index.set`, type semantics, and commit protocol), surface the tradeoff and propose the smallest consistent solution rather than silently deciding. Catalog scaling currently uses a bounded recursive tree rooted at `index.json`.
5. Make incremental changes with executable tests; report what was tested and what remains unsupported.
