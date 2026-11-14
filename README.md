# CoCreateDB

CoCreateDB is a JavaScript ESM project for storing CoCreate objects as JSON files and maintaining ordered indexes over their fields. The current filesystem prototype is independently usable and does not require CoCreate Server.

## Filesystem storage and CRUD `send`

Create a local instance by providing its storage root. A fresh root is initialized as requests arrive:

```js
import { createDB } from '@cocreate/db'

const db = createDB({ directory: './example-storage' })

const created = await db.send({
    method: 'object.create',
    organization_id: '000000000000000000000001',
    storage: 'production',
    database: 'example-db',
    array: 'users',
    object: {
        name: 'Ada',
        age: 31,
        active: true,
        'profile.city': 'Lima'
    }
})

const result = await db.send({
    method: 'object.read',
    organization_id: '000000000000000000000001',
    storage: 'production',
    database: 'example-db',
    array: 'users',
    filter: { query: { 'profile.city': 'Lima' } }
})

console.log(created.object[0]._id)
console.log(result.object)
```

Run the checked-in example to populate the ignored `example-storage/` folder with object files, regular indexes, and the local `example-node` partition-holder map:

```sh
npm run example:filesystem
```

The local layout is created on demand:

```text
example-storage/
  <organization_id>/
    storages/
      index/                   # storage name -> stable storage ID
      <storage_id>/
        storage.json
        databases/
          index/               # database name -> stable database ID
          <database_id>/
            database.json
            arrays/
              index/           # array name -> stable array ID
              <array_id>/
                array.json
                index/
                  index.json
                  <field-index-node-id>.json
                objects/
                  <object-id>.json
                deleted/
                  <object-id>.json
```

Logical storage, database, and array names map to stable 24-character ObjectIds through recursive name indexes; the shared `ObjectId()` utility generates these IDs, while `uuid()` generates 32-character hexadecimal internal index-node IDs. Data directories use those IDs, so renaming a database or array updates its catalog and metadata without moving objects. Database and array metadata JSON can hold configuration such as future encryption settings.

`send()` supports create/read/update/delete for databases and arrays, and object CRUD. Database and array create/delete requests accept one name or a list of names. Update renames one target with `database` or `array` set to the current name and `name` (or `newName`) set to the new name; an optional `config` object is merged into its metadata. Database reads return metadata records in `response.database`; each database includes its `arrayLength`, `objectLength`, and arrays. Array reads return records in `response.array`, with each record carrying its `name`, stable `_id`, total object `length`, and `$database` reference. Array operations require one database name. Object writes can create missing database and array catalog entries implicitly. Deleting an array removes its objects and indexes; deleting a database removes all of its arrays and data.

Read requests use the shared CoCreate filter shape: `filter.query` is evaluated with `queryData`, `filter.search` with `searchData`, `filter.sort` with `sortData`, `filter.key` applies an inclusion/exclusion projection, and `filter.limit` plus `filter.index`/`filter.startingIndex` select a page. For a multi-source client, CoCreateDB leaves the global `filter.index` to the client and updates only its source entry in `filter.storages`, including source `count`, `startingIndex`, and the next source `index`. Source counts reflect query matches before `search` and pagination, matching MongoDB's `countDocuments(query)` behavior.

Database, array, and object records use the same record contract: create writes the record and indexes its supported values through the recursive index processor; read resolves IDs or names through those indexes before loading JSON; update diffs old and new index entries; delete removes indexed values and the record. Database and array metadata therefore receive the same automatic field indexing as stored objects. Their `created` and `updated` audit fields use `{ on, by }`, following the object CRUD convention; `by` comes from `user_id` or `clientId` when supplied. Array metadata stores total objects in `length`; database metadata stores totals in `arrayLength` and `objectLength`. These values are ordinary indexed metadata fields maintained through record updates. Query `count` remains the number of records returned by the matching source before search and pagination.

Object create accepts one object or an array. Read accepts an object with `_id`, an equality query such as `{ fieldA: 'a' }`, or no query to enumerate the array. Query matching uses `queryData` from `@cocreate/utils`, including its field operators (`$eq`, `$ne`, `$not`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$all`, `$elemMatch`, `$size`, `$exists`, `$regex`, `$type`, and `$mod`) and logical operators (`$and`, `$or`, and `$nor`). Equality conditions can use CoCreateDB indexes to find candidates; the shared utility then checks matches. Other query shapes currently scan candidate objects. Equality preserves value types, so number `9` and string `'9'` are distinct. Range operators use JavaScript's native relational operators without type normalization; for example, `'20' > 10` is true while `'20' > '3'` is false because string-to-string comparison is lexical. Updates use `createUpdate` from `@cocreate/utils`, including its field and array operators; CoCreateDB maintains indexes from the resulting object. `$set` remains supported as a CoCreateDB convenience. Updates can target an object by `_id` or `filter.query`; deletes accept an object with `_id` or a query filter. Responses include the affected `object` array.

The array field-catalog root's `length` is the number of stored objects, maintained through the one-entry-per-object `_id` index. `catalogLength` describes available key/type mappings. Each index node and child reference uses `length` for available subtree entries. Each catalog mapping stores `[key, type, rootId, { length, first, last }]`, refreshed on every branch mutation. Empty key/type roots are removed from the catalog after their final entry is deleted.

## Automatic indexes

On create, CoCreateDB creates an independent index for `_id` and each supported field path. Nested object leaves use dot notation, so `profile.city` is indexed as its own key. Array elements are indexed under their field path. No compound indexes are created automatically; a query combining fields can use the independent indexes. Custom indexes for other purposes can be considered later.

The current ordered index supports finite numbers, strings, booleans, explicit `null`, and arrays in separate type branches. Ordinary objects are recursively indexed by full dot-notation leaf paths. Arrays are terminal values: their complete contents are stored whole under the field index's `values/` directory, and one digest entry points to each array value. Array contents do not create positional or nested field index paths. The object document remains the source used to return query results.

Array membership, `$all`, `$elemMatch`, `$size`, and other supported shared query operators inspect the complete terminal array values, then the normal query utility verifies matching documents. Queries into properties of objects inside arrays (for example, `projects.name`) remain supported by the query utility but currently scan the candidate documents because those nested paths are intentionally not indexed. Bracket paths such as `projects[0].name` use the shared notation/query behavior and do not create positional index branches. Large array values are stored whole outside index nodes; legacy numbered chunks remain readable; array edits replace one terminal value entry rather than maintaining an index for each position.

## Worker and socket distribution

Successful CRUD use produces server-generated `distribution` references from the
same stable organization/storage/database/array/object identities used by entity
availability. Individual documents have references ending in
`objects/<objectId>.json`. List reads also retain an array reference, so an empty
or filtered list can receive later creates. Matching currently uses array scope
for lists; it does not evaluate each client's query before sending a change.

DB records the originating logical worker ID in `Workers.distribution`, a
`Map<reference, Set<workerId>>`. DB then sends the internal `db.distribution.set`
control to that worker, carrying organization identity, client ID, and references
inside `data`. The worker records the client in `Socket.distribution`, a
`Map<reference, Set<clientId>>`, before the CRUD response returns. Repeated reads
reuse the references and deduplicate recipients. The co-located primary/worker
uses the same control event locally. A distribution reference is routing metadata,
not permission; socket authorization still applies.

CRUD responses carry `distributionKeys` for delivery matching. Reads return to
the requester. Mutations return to the requester and registered recipients; the
payload remains the normal resolved CRUD value. Peer document mutations use the same
local worker/client delivery path after DB applies them. Node replication remains
on DB's holder-targeted Mesh path instead of a second broad CRUD broadcast.
Clients send ordinary CRUD requests and receive no distribution control events.
Elements sends ordinary CRUD without subscription keys, and Socket routes CRUD
using DB-owned distribution. The legacy subscription handler and Socket
subscription APIs have been removed. Distribution removal, disconnected-client cleanup,
and worker/restart reconstruction are deferred; the new maps are process-local.

## Distribution index partitions

`db.distribution.local` is this node's inventory. Its `snapshot()` method reads
namespace catalogs and saved holder indexes without scanning document files.
`db.distribution.peers` contains only other nodes' inventories and lives entirely
in memory. Existing holder lookup methods combine these views; peer inventories
are never written through the local index or persistence queue.

`db.disk` defaults to `true`. With `disk: false`, data and local distribution stay
in memory and all local disk reads/writes are disabled. This setting does not
itself disable configured external persistence; the existing external-persistence
feature gates remain unchanged. `memoryOnly` remains the stricter testing mode.

On a control-peer connection, DB sends its complete local inventory using
`db.distribution.sync`. The recipient replaces that sender's previous inventory
and replies once with its own local inventory. Session IDs and revisions reject
older snapshots/changes. Add/remove announcements continue incrementally.
Disconnecting a peer removes its contribution; reconnection exchanges inventories
again. These exchanges are full inventory messages, not document snapshots.

Local entries use a stable local marker on disk, translated to the current server
ID when read. New inventories therefore survive server-ID changes. Legacy entries
matching the current server ID are supported and upgraded as they are used;
older combined mappings cannot safely be attributed to a different server ID and
are excluded rather than advertised as local holdings.

`distribution` names the metadata used for data placement and synchronization.
The public factory is `createDistributionIndex`; DB methods are
`updateDistribution`, `getDistribution`, `listDistribution`, and
`clearDistributionCache`. Adapters use `distributionAdapter`, and availability
events use `db.distribution` (including `.local`, `.update`, `.get`, and `.list`).
This naming change does not automatically migrate existing metadata directories.

`CoCreateDB.init(server)` initializes the server-owned database, prompts for `db.directory` when it is not configured, and attaches the instance as `server.db`. Leaving the prompt blank uses the process working directory. `COCREATE_DB_DIRECTORY` remains an environment override. Optional `db.persistence` configuration supplies persistence options; `db.persistence.workflow` can require external persistence acknowledgment. Without it, CoCreateDB persists locally in the configured directory.

Every regular index root or node written by CoCreateDB is recorded in local distribution. Local partition inventory is stored under `distribution/partitions/index/` when disk is enabled; peer holdings are kept separately in memory. When an index partition is first acquired, the node adds itself locally and announces its availability. When a regular index partition changes or is removed, the update is sent only to its recorded holders. Unchanged holder mappings do not generate incremental announcements, but connection snapshots still advertise them. Index partition files retain their normal `first`, `last`, `length`, and entry metadata.

If recursive traversal needs an index file that is missing locally, CoCreateDB checks the partition holder map and requests that exact file from a holder over the targeted Cluster mesh. The received file is validated, written locally, and the node is registered as another holder. An advertised partition that no holder can provide produces an error rather than an empty query result. A configured file-level storage fallback is not implemented yet.

The existing database/array/object availability map remains in place for the current exact-ID metadata and document acquisition path. It is transitional: the agreed direction is to use the regular index trail and index-partition locations to resolve data, rather than make a separate object-location map the query architecture. Acquired documents are still materialized through CRUD/indexing before response projection. Initial partition-map snapshot transfer to a clean node, external storage fallback, and chunked terminal-array value transfer remain open implementation work.

CoCreateDB does not currently upload filesystem files to external storage. No shared file-level adapter contract exists in the current CoCreate CRUD provider drivers. If one is introduced, the proposed minimum is individual-file `read`, `write`, and `delete` operations addressed by validated database/array/entity IDs and a logical file kind; CoCreateDB must never pass a `distribution/` path to that adapter. Distribution Index files remain local Cluster metadata.

## Index API

CRUD envelopes (`index.create`, `index.read`, `index.update`, `index.delete`) route
to one index handler. Each `index` entry contains `{ key, value, objectId }`;
reads need only `key` (default `_id`). The corresponding direct methods use the
same names. Create and update currently both insert an entry; replacing a value
still requires deleting its old entry first. No new index behavior is introduced.

The index primitive remains separately usable:

```js
import { createIndex } from '@cocreate/db'

const index = createIndex({ directory: './example-storage' })
await index.create('example-db', 'users', 'age', 31, '0123456789abcdef01234567')

for await (const entry of index.scan('example-db', 'users', 'age', {
    type: 'number'
})) {
    console.log(entry) // { value: 31, objectId: '0123456789abcdef01234567' }
}
```

The logical index address is `database + array + key`. In `createDB`, logical names resolve to stable database and array IDs before object/index access; the returned `db.index` facade continues to accept logical names. Each array ID directory contains an `index/` directory. `index.json` is the catalog tree's stable root. It stores entries while they fit; when it exceeds the configured byte limit, the entries move into 32-character hexadecimal child nodes and the root points to them. Those catalog nodes can split recursively like field-index nodes. Indexes use filesystem persistence by default without an in-memory node cache; opt into a Map cache with `createIndex({ cache: true })` or `createDB({ cache: true })`.

`createIndex({ maxBytes })` and `createDB({ maxIndexBytes })` set the preferred serialized byte target for catalog and field-index nodes. The default is 128 KiB; this is a tunable starting point, not a benchmark-derived optimum.

## Current limits

- The new ID-addressed layout does not automatically migrate data written under the previous `<database>/<array>` directory layout.
- Filesystem storage is a local prototype. Object payloads and indexes share the configured root; there is no cloud/storage-provider fetch path yet.
- Query matching and updates share `@cocreate/utils`; utility semantics and limitations are inherited. Equality and range queries can use field indexes, while other query conditions may scan candidate objects. Mixed-type range planning scans each indexed type branch to preserve native JavaScript comparison behavior. Index updates are maintained after shared update operators run, but multi-object updates are not transactional.
- Index-holder nodes receive full creates, update patches, and object deletions and the current database/array metadata after the corresponding index partition updates. This is event-driven replication for known holders; user subscription lifecycle and inactive-node pruning are still future steps.
- Object requests target one database and one array; array operations target one database. Multi-target object fan-out is not implemented.
- Index partition acquisition is targeted by the local partition-holder map. A clean-node holder-map snapshot, restart reconstruction, external storage fallback, and chunked terminal-array value acquisition are not implemented yet.
- The legacy peer data path still targets exact `_id` reads using entity availability references. It is transitional; replacing it with complete index-trail resolution for documents and storage remains future work. Document mutation delivery has no durable acknowledgement/retry or reconnect recovery, and concurrent cross-node writes have no version conflict handling.
- Index and object writes are not a multi-file transaction. Server-integrated writes are serialized through the primary, but standalone multi-process writers are unsupported; the prototype does not provide crash recovery or distributed consistency.
- Missing, empty, or unsupported field values do not currently receive index entries. The stored object remains intact.

## Development

Run the tests with Node.js:

```sh
npm test
```

Tests use temporary storage roots and verify create/read/update/delete flows, field and nested-field removal, object counts, empty-index pruning, per-field indexes, ordered scans, splits, persistence after reopening, and Cluster propagation of full document mutations to index-partition holders.

## Package and repository

```sh
npm install @cocreate/db
```

[CoCreateJS/db](https://github.com/CoCreateJS/db)

## License

AGPL-3.0. See [LICENSE](LICENSE).

## Query planning statistics

`index.getMetadata(database, array, key)` (also exposed on `db.index`) reads the catalog's per-type `id`, `length`, `first`, and `last` summaries without opening the value roots for current entries. Old `count`/`catalogCount` nodes and three-item catalog mappings remain readable and are upgraded lazily when mutated; query result `count` is unchanged.

AND clauses are ordered by estimated work before scanning. An empty candidate set stops subsequent scans; expensive residual predicates, including OR groups, can instead be checked against a small candidate set. Metadata is reused within the query. Length estimates are heuristic and do not measure distinct values. Scalar numeric/string ranges use index bounds where comparison semantics permit; other types retain native JavaScript comparisons. `_id` is automatically indexed, including its length and boundaries, and supports `$gt`, `$gte`, `$lt`, and `$lte` ObjectId-string ranges. Results still hydrate before sorting and pagination.

## Primary-owned runtime and on-demand memory cache

Server workers register a lightweight driver with only `send()`. Every database,
array, and object CRUD request uses the existing awaitable `db.send` IPC envelope
to reach the primary. Only the primary creates the engine and on-demand cache.
Memory transactions and index reconciliation use the primary queue. Object writes
respond after applying their memory revision; pending documents supplement index
candidates so queries remain correct before indexing completes. After successful
indexing, completed changes are dispatched to holders through Mesh and local
workers through `db.indexed`, before sequential disk persistence. The worker CRUD
layer uses the existing response flow; the internal execution request is not a
broadcast mutation.

`createDB({ directory, memoryCache: true })` starts with an empty cache for a previously unopened directory. It does not enumerate or preload stored JSON files. Objects, catalogs, index nodes, and array chunks enter the cache as operations read or write them. Reads return the owned live objects; successful writes mutate the cached objects in place, and deletes invalidate their paths. Existing instances in the same process share cached files for the same directory. `memoryCache: false` leaves this shared cache disabled for a directory that has not already been enabled.

The server integration enables this on-demand cache by default. `db.ready` remains available for compatibility and reports zero files preloaded. `db.memoryStats()` reports retained files and their serialized JSON size, not actual heap usage. The separate index-only `cache` option remains opt-in.

There is currently no automatic memory budget, eviction, or idle timeout. A proposed next step is a process-wide byte budget with least-recently-used eviction across all cached data types. An optional idle timeout can release inactive items sooner; it is not a substitute for a budget. Cache eviction must only drop memory copies, preserve persisted data, and continue to honor mutation/replication invalidation. Subscription-driven cleanup remains a separate, unfinished part of the distributed lifecycle.

## Operator regression coverage

`test/operators.test.js` checks the supported Utils query operators through DB CRUD with memory caching disabled and enabled, including recursive index splits, mixed value types, nested array paths, logical conditions, and ObjectId ranges. Query results are compared with shared `queryData` evaluation. Update cases assert independent expected records, the resulting index entries (including stale-entry removal), persisted reads after clearing memory/reopening, and rejection of invalid or immutable-ID mutations.

DB forwards `$set` intact to Utils so literal operator strings and array-position replacement keep their intended meaning. Top-level/global update operators receive the same path and `_id` validation as operators inside `object`. Invalid record updates are rejected before the prepared property-slot changes are attached.

Native JavaScript comparisons can make ordinary objects participate in string/object range predicates, although ordinary objects have no terminal value-index branch. Those predicates conservatively verify documents rather than treating scalar branches as complete. `_id` bounds and scalar numeric bounds retain index pruning. Strict type-only comparisons or a versioned presence/type index could improve this case later; this pass preserves query semantics.

## Write-behind persistence

Server integration defaults to `writeBehind: true`; pass `writeBehind: false` to
`initializeServerDB` for the previous write-through response boundary. Standalone
`createDB()` remains write-through by default.

Documents are acknowledged in memory before indexing and disk/storage completion.
An address/revision queue coalesces repeated writes and persists paths sequentially,
without retaining serialized transaction payloads. Indexing must succeed and its
change messages must be dispatched before persistence starts. An update arriving
during a write remains pending after the older acknowledgment. Dirty paths stay
pinned through cooldown and required acknowledgments; persisted values remain
cached without automatic eviction. `persistenceOptions.debounceMs` defaults to
25 ms per path, reset by each write. `maxWaitMs` defaults to 1000 ms to bound
continuous resets once indexing is ready. Index reconciliation and propagation
are not debounced. Explicit `flush()` bypasses the persistence cooldown.

`db.persistenceStats()` exposes pending persistence paths, pending index entries,
and the latest errors. Server-integrated delivery/replication failures also remain
available as `persistenceStats().backgroundError`, containing the method and its
accumulated error array. Runtime DB failures are not written to the console.
Request failures append to `data.error` (an array), preserving earlier errors.
`await db.flush()` drains indexing and eligible writes;
`await db.close()` drains and unregisters the adapter. Close the DB before removing
its directory. The primary registers a graceful shutdown handler. Drain while
quiescent for a complete shutdown boundary.

Configure `db.persistence` to customize write-behind persistence after local
indexing. Without this configuration, CoCreateDB writes to the local directory.
Set `db.persistence.workflow` (or `COCREATE_DB_PERSISTENCE_WORKFLOW`) to require
external persistence acknowledgment after each local disk operation. The older
`storageWorkflow` option and `COCREATE_DB_STORAGE_WORKFLOW` variable remain aliases.
The workflow calls
`server.workflow.run({ method: 'workflow.<name>', organization_id, host,
storage: [{ path, operation, revision, options, value }] })`.
Paths are relative to the DB root; `value` is the snapshot for that flushed
revision, including document/index/chunk JSON. `operation` is `set` or `remove`.
The workflow must return `success: true` without errors. Missing/unavailable
configured storage retains pending work for retry; no configured workflow means
disk acknowledgment is sufficient. Workflow implementation is intentionally
left to the separately configured workflow process.

Retries are process-local and not a durable journal. Success now acknowledges
volatile memory, not crash-safe persistence; Mesh send is not durable replication.
A failed index revision conservatively gates the root's persistence because
catalogs and nodes are shared. Multi-file crash recovery and cross-server conflict
resolution remain outside this prototype.

### Deleted object lifetimes

Deletion retains a small `deleted/<objectId>.json` marker alongside `objects/`,
recording the deleted object's `created.on`. Ordinary ID-based updates fail while
the marker exists; stale peer materialization and replicated copies cannot
resurrect that lifetime. An explicit create or missing-object `upsert: true`
starts a new `created.on`, clears the marker, and preserves the reused ID.
Late deletes/replicated writes from older lifetimes cannot overwrite the new one.
`created.on` is immutable on ordinary updates. Requests that carry the old creation
date fail after recreation; an ID-only update cannot express which lifetime its
caller intended. Creation dates are not a general cross-server revision clock.
Markers follow the same persistence acknowledgments and have no automatic purge.

## Update patches and resolved results

An `object.update` can supply `$update` on each object or on the request envelope.
DB uses a supplied patch as-is, including its original operands. When absent,
`createUpdatePatch` collects the request's fields and operators into a patch using
the existing shared update syntax. It preserves increments, array operations,
literal `$set` values and explicit removals. Undefined assignments in generated
patches become `$unset` entries so JSON transport preserves their meaning.
Per-object patches take precedence over an envelope patch. A supplied patch is
the mutation input; accompanying snapshot fields and global operators are not
applied a second time. There is no additional patch-schema validation pass;
unsupported operations report the ordinary shared update utility error.

Client replies and worker/index notifications include the complete resulting
record with `$update` alongside it. Peer updates contain only `_id`, `$update`,
and audit metadata; creates and new-lifetime upserts still deliver full records.
For example, the client receives:

```js
{ _id: '...', score: 12, name: 'Ana', $update: { $inc: { score: 2 } } }
```

The peer receives the same patch without the full document:

```js
{ _id: '...', $update: { $inc: { score: 2 } }, updated: { on: '...' } }
```

Delivery containers share nested values and the supplied patch by reference.
`$update` is never attached to the DB-owned document or persisted JSON. Local
persistence retains the complete resulting record. No-op replies keep the patch
without scheduling additional document/index persistence. Deferred indexing can
coalesce by object address, but retains every update patch for propagation.

A peer applies `$update` to its existing document using the shared update utility,
preserving unrelated local fields. It does not originate the operation again.
A peer missing the base fetches a current full record from the publisher; that
snapshot already includes the patch, so it is not replayed over that snapshot.
Index partitions continue through the existing holder-targeted partition path.

This server stage leaves IndexedDB, browser optimistic acknowledgments, client
rendering, operation ordering, duplicate recovery and field-conflict policies for
separate work. Existing document lifetime/deletion checks and persistence hooks
are retained. Full-record snapshots remain the acquisition/recovery mechanism.

## Organization and logical storage scope

Public `createDB().send()` requires `organization_id`, `storage`, and `database`.
It does not choose defaults or providers. Organization IDs are 24-character
hexadecimal IDs and form the first directory beneath the DB root. Storage names
resolve through the organization's recursive storage catalog to stable IDs;
renaming storage updates its name reference and metadata without moving data.
`storage.create/read/update/delete` operate on this logical namespace. Existing
storage IDs are preserved across replicas. Each request addresses one namespace.

CRUD imports the DB service directly. It supplies absent storage/database values
from a matching hostname, then defaults them to `production` / `app`. Explicit
request values take precedence. CRUD never defaults or rewrites `array`; DB
validates it for object CRUD. Namespace `storage` is unrelated to providers.
`GetDriver` remains available as legacy tooling but is not used in CRUD dispatch.

`db.forScope({ organization_id, storage })` exposes a namespace's independent
engine for index inspection. The public index facade also accepts scope first:
`db.index.read(scope, database, array, key)` and `db.index.scan(scope, ...)`.
Distribution entity tuples include organization/storage IDs; regular partition
paths include the entire namespace prefix. Internal Mesh messages carry that
identity inside `scope`, preserving control-event rather than client routing.
Storage metadata changes propagate separately from object mutations.

One root persistence queue and memory cache serve all namespaces. The existing
memory acknowledgment, changed-field propagation, cooldown, retry, and sequential
persistence behavior remains. Persistence providers/endpoints are not redesigned.
The former root-level `databases/` layout is not read or migrated by the new API.
Existing workspace data is left untouched for the user to reset/rebuild.

## Live-reference memory-only mode

```js
const db = createDB({ directory: '/logical/node-root', memoryOnly: true })
```

This mode operates on cache, indexes, and distribution without loading or writing
DB files or invoking persistence providers. Creates adopt their input object;
unprojected reads reuse that object, and updates mutate it in place after operand
validation. Treat returned values as DB-owned live references. Use DB update APIs
for indexed changes. No automatic eviction or isolated read snapshots are added.
`flush()` completes deferred index work in this mode.

Traversal and propagation retain references instead of cloning nodes/documents.
Queued update propagation retains the original patches and their operands. Node size is a split target; a large indivisible entry is allowed.
Persistence adapter redesign is deferred; this phase's no-clone guarantees and
benchmarks apply to the memory-only core. See ARCHITECTURE.md for the current
contract and the distinction from earlier detached-copy/rollback descriptions.

### Replication size checks and local file sizes

Index mutations do not serialize nodes to measure them. When replication encodes
an index node, its bytes are compared with the preferred `maxIndexBytes` target
(default 128 KiB). Oversized nodes split locally at the positional midpoint when
possible; parent/catalog references are updated before the replacement frames are
sent. Single entries and minimum-fanout nodes may exceed the target without an
error. Whole documents are not split. Without replication, indexes can remain
above target. Mesh reuses an unchanged node's prepared encoding.

Local disk writes also capture complete-file UTF-8 bytes from the existing
encoding. Each directory's private `.bytes` sidecar maps JSON filenames to their
last-persisted lengths. Sidecars are never replicated or used to trigger splits.
Write-behind updates are batched per persistence pass; deletion removes entries.
Memory-only mode writes no sidecars. Existing files are not automatically scanned,
and custom persistence writers are responsible for their own accounting. These
measurements describe persisted file contents, excluding accounting overhead;
they are not heap measurements or a deduplicated global database total. Telemetry
reporting is deferred.

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
