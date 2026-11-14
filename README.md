# CoCreateDB

CoCreateDB (`@cocreate/db`) is CoCreate's filesystem-backed database engine.
It provides storage, database, array, object, and index CRUD through `send(data)`.
The recursive index engine is also independently usable.

## CRUD and hierarchy

```js
import { createDB } from '@cocreate/db'

const db = createDB({ directory: './data', memoryCache: true })
const scope = {
    organization_id: '000000000000000000000001',
    storage: 'production', database: 'app', array: 'users'
}

const created = await db.send({
    ...scope, method: 'object.create', object: { name: 'Ada', score: 1 }
})
const response = await db.send({
    ...scope, method: 'object.read', object: { _id: created.object[0]._id }
})
await db.close()
```

`method` selects the target and operation, for example `database.update`.
Each target supports create/read/update/delete. Database and array updates rename
metadata or merge configuration. Storage updates currently rename the storage.
Logical names resolve through catalogs to stable IDs, so renames do not move data.

The fixed hierarchy is organization → storages → databases → arrays → objects.
Nested storages/databases are not implemented. Metadata, objects, field indexes,
and terminal array values have their own files. Organization and entity IDs are
24-character ObjectIds; internal index node IDs are 32-character hexadecimal IDs.

```text
<directory>/<organization_id>/storages/
  index/                           # storage catalog
  <storageId>/
    storage.json
    databases/
      index/                       # database catalog
      <databaseId>/
        database.json
        arrays/
          index/                   # array catalog
          <arrayId>/
            array.json
            objects/<objectId>.json
            index/                 # field/type catalog and recursive nodes
              values/.../value.json
```

## Configuration and lifetime

`CoCreateDB.init(server)` attaches `server.db` to Cluster. Workers forward requests
to the primary; they do not own database engines or filesystem caches.
`initLocal(options)` and `createDB(options)` support standalone use.

```js
{
    db: {
        directory: './data',
        disk: true,
        memoryCache: true,
        writeBehind: true
    }
}
```

`disk` defaults to true. With `disk: false`, both data and local distribution use
memory without disk reads/writes. This does not itself disable external
persistence. `memoryOnly: true` is the stricter test mode and disables external
persistence too. Server defaults enable memory caching and write-behind;
standalone defaults use write-through without retaining a shared memory cache.
`COCREATE_DB_DIRECTORY` overrides the configured directory. Otherwise the default
is the process working directory; server initialization can prompt for it.

Files are loaded on demand, not eagerly at startup. DB-owned values remain live
references; callers should not mutate supplied/returned values outside DB APIs.
Server mutations acknowledge the live result before deferred indexing and disk
flush. `flush()` drains indexing and queued writes; `close()` flushes before closing.
An acknowledgment is not crash durability until those disk writes finish.

API errors accumulate in `data.error` arrays and set `success: false`. Background
DB delivery failures remain inspectable through `persistenceStats().backgroundError`.
DB API failures do not write console logs. Workflow errors likewise accumulate on
the payload being processed; workflow invocation needs no `internal` flag.

## Read resolution and acquisition

The existing lookup order is memory → disk → known peer holders. Missing index
partitions are requested by path; complete records can be requested by scoped
entity ID. Disk text is parsed by file I/O and network JSON by the transport.
DB receives parsed values, not JSON strings embedded inside `value`.

Acquired partitions are installed locally; acquired records use the local
object/index pipeline before response projection. Local writes follow `disk` and
write-behind settings. Acquisition does not publish a new user mutation.
Metadata discovery and object retrieval have separate paths: this is not yet one
uniform resolver for every CRUD target. An advertised partition whose holders
cannot supply it produces an error. File-level persistence-workflow fallback is
not wired yet.

## Update contract

Each object can provide `$update`; an envelope-level `$update` is also accepted.
The server reuses a supplied patch. Otherwise it constructs one from the original
request, preserving operators and operands. Shared update utilities apply it
locally. API execution errors accumulate normally; DB does not rewrite a supplied
patch into a different schema.

Clients receive the resolved document plus `$update`. Existing peer documents
receive `_id`, `$update`, and update metadata, rather than a full stale document.
A peer missing the base acquires the sender's current record without replaying a
patch already included in it. A create followed by updates before initial indexing
publishes the final create snapshot. Disk stores the complete document without
transport `$update` metadata.

Cross-node ordering, field conflict rules, operation deduplication, and client
IndexedDB changes remain separate work. `$inc` retains its delta in the patch;
this alone does not establish exactly-once delivery or distributed merge policy.

## Distribution and delivery

- `db.distribution.local` describes this node's holdings and follows `disk`.
  `local.snapshot()` reads namespace catalogs and holder indexes, not document files.
- `db.distribution.peers` contains other nodes' inventories in memory only.
  Incoming inventories never pass through the filesystem index writer.
- `Workers.distribution` maps data references to workers in memory.
- `Socket.distribution` maps those references to connected clients in memory.

Local holdings do not imply that the corresponding data is loaded in RAM or has
active clients. CRUD requests register the originating worker and client using
DB-generated references. Changes route to holder peers and interested local
workers/clients; distribution references do not bypass socket authorization.
Client/worker subscription cleanup and reconstruction are separate lifecycle work.

Control-peer connection exchanges use `db.distribution.sync`: send local inventory,
merge the peer's contribution, and reply once with local inventory. A complete
snapshot replaces only that sender's contribution. Session/revision metadata keeps
older snapshots from undoing later changes. Incremental availability announcements
continue afterward; disconnect removes the peer's contribution and reconnect
exchanges inventories again. Full inventories currently use one message; batching
is not implemented.

Local inventory directories retain their existing layout. A stable local marker
is translated to the current server ID, allowing new inventories to survive server
ID changes. Legacy current-owner entries are upgraded as accessed; foreign claims
are removed from the local inventory. Legacy ownership under an already changed
server ID cannot be inferred safely and is not silently adopted.

## Automatic index and index CRUD

The same recursive engine indexes namespace catalogs and object fields. Supported
values have separate number/string/boolean/null/array branches, ordered by value
and then object ID. Ordinary object leaves use dot paths. Terminal arrays are
stored whole outside index nodes; legacy numbered chunks remain readable. Query
matching uses shared utilities; nested array-member queries can require scans.
Custom index definitions and uniqueness constraints are not implemented.

```js
import { createIndex } from '@cocreate/db'
const index = createIndex({ directory: './indexes' })
await index.create('app', 'users', 'score', 1, '000000000000000000000002')
const root = await index.read('app', 'users', 'score')
await index.delete('app', 'users', 'score', 1, '000000000000000000000002')
```

`update` currently has the same entry-insertion behavior as `create`; replacing a
value still requires deleting its old entry. The default read key is `_id`;
database and array are required. DB exposes corresponding scoped methods such as
`db.index.read(scope, database, array, key)`. `getMetadata`, `scan`, and partition
I/O remain separate traversal utilities.

CRUD envelopes use one index handler and `index: [{ key, value, objectId }]`.
Read entries need only `key`; responses use `response.index`.

Index nodes split only while encoding for peer delivery, using the preferred
128 KiB target and positional midpoint. Parents are updated and affected holders
notified. Indivisible entries may exceed the target. There is no startup/on-load
size-healing pass. Private `.bytes` sidecars record existing disk-encoding sizes;
they are not replicated, indexed, or used to trigger splits.

## Persistence: current boundary and agreed next step

Local disk and configured persistence are separate. External workflow writes are
currently disabled. The retained hook still uses a `storage` payload and checks
`success: true` with no errors; a config alone does not enable file-tree persistence.
The opt-in `externalPersistence` bridge is legacy object-read recovery, defaults
off, and installs complete provider records before re-serving a local read.
It is not the future persistence workflow's file-read interface.

The agreed workflow envelope, not yet wired, is:

```js
{
    method: 'workflow.<configured-name>',
    organization_id: '...', host: '...',
    persistence: [{
        method: 'persistence.update',
        path: '.../index.json',
        value: { /* complete parsed file contents */ }
    }]
}
```

Persistence create/read/update/delete are workflow input operations, not separate
provider methods in DB. Reads must return parsed file values suitable for the same
acquisition paths as peers, followed by local caching when disk is enabled.
Persistence retry/acknowledgment and response-versus-durability semantics still
need implementation. Preserve the disconnected hooks until that work is decided.

## Development and remaining work

Run `npm test` or targeted `node --test test/<file>.test.js` suites. Tests use
isolated directories; passing them does not prove live provider or real-network
recovery. Known rollback/write-behind and workflow URL-test baseline failures must
be reported separately from passing focused suites.

See [NEXT_TASK.md](NEXT_TASK.md) for remaining work and
[ARCHITECTURE.md](ARCHITECTURE.md) for detailed index design and historical decisions.
Read [AGENTS.md](AGENTS.md) before changing index internals.

CoCreateDB is licensed under AGPL-3.0; see [LICENSE](LICENSE).
