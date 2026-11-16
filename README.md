# CoCreateDB

### One Database Engine. Any Runtime. Any Storage.

**Not just a Data Lake. Not just a Data Warehouse. An Intelligent Data Ocean.**

**Local-first. Memory-first. AI-native. Storage-agnostic. Distributed by design.**

CoCreateDB is a lightweight, JavaScript-native NoSQL document database engine built for rich querying, intelligent indexing, and flexible persistence.

Designed to work across devices, runtimes, clouds, storage providers, and database systems, CoCreateDB brings database intelligence closer to applications while separating data processing from where data is stored.

**Your data doesn't have to live where your database runs.**

[GitHub](<https://github.com/CoCreateJS/db>) · npm: `@cocreate/db` · [CoCreateJS](<https://github.com/CoCreateJS>)

---

## Why CoCreateDB?

Traditional database architectures often require dedicated servers, network communication, caching infrastructure, and separate storage services.

CoCreateDB takes a different approach.

- **In-process execution:** Run database operations directly inside Node.js without a separate database server.
- **Rich document querying:** MongoDB-inspired queries, updates, deletes, sorting, and nested object operations.
- **Independent indexing:** Segmented indexes enable selective access to data without loading entire collections.
- **Memory-first performance:** Keep frequently accessed data in memory and retrieve other objects on demand.
- **Storage independence:** Separate querying and indexing from physical persistence.
- **AI-ready architecture:** Expose structured metadata and indexing primitives to authorized AI workflows.
- **Distributed vision:** Support local-first processing, synchronization, and data placement across infrastructure.

CoCreateDB is designed to minimize infrastructure requirements without sacrificing expressive document operations.

---

## An Intelligent Data Ocean

CoCreateDB introduces the concept of a **Data Ocean**: a unified, metadata-driven data architecture connecting active computation, distributed memory, and durable storage.

Rather than treating data as a static repository, the Data Ocean vision describes how information can move between active and persistent states.

### Surface Currents — Active Memory

Frequently accessed data remains in memory, close to the applications using it.

Local execution avoids unnecessary database-server communication and enables fast reads and writes.

### Deep-Water Persistence — Durable Storage

Inactive data can reside in local filesystems, object storage, or external databases without occupying application memory.

Storage capacity and application compute can scale independently.

### Upwelling — On-Demand Hydration

CoCreateDB uses independently addressable indexes and metadata to identify relevant data.

Only the required index partitions and objects need to be retrieved, rather than loading entire collections.

**Active when needed. Persistent when idle. Discoverable through indexes.**

The broader Data Ocean architecture envisions this behavior across multiple clouds, regions, devices, and storage providers. Distributed lifecycle automation and provider support depend on implementation maturity.

---

## One Engine. Any Environment.

CoCreateDB is designed to separate database intelligence from the environment in which it executes.

| Dimension | Intended environments |
| --- | --- |
| **Any Device** | Browsers, desktops, mobile, servers, edge devices |
| **Any Runtime** | Client-side, server-side, serverless, distributed |
| **Any Cloud** | AWS, Google Cloud, Azure, DigitalOcean, private infrastructure |
| **Any Storage** | Memory, filesystem, IndexedDB, S3-compatible storage, cloud buckets |
| **Any Database** | CoCreateDB and external database persistence adapters |

CoCreateDB currently targets Node.js. Other runtime and storage integrations are part of its portability vision and should be verified individually.

### Where It Fits

CoCreateDB is particularly relevant for Node.js backends, self-hosted applications, microservices, local-first systems, development tools, data-processing services, and applications exploring distributed or object-storage-backed persistence.

It is also intended to serve as the native database engine for CoCreate Server while remaining independently usable.


A typical starting point is an embedded Node.js service that stores and queries documents in a named array:

```js
import { createDB } from '@cocreate/db'

const db = createDB({ directory: './data' })
const scope = {
  organization_id: '000000000000000000000001',
  storage: 'production',
  database: 'app',
  array: 'users'
}

const created = await db.send({
  ...scope,
  method: 'object.create',
  object: { name: 'Ada', status: 'active' }
})
const result = await db.send({
  ...scope,
  method: 'object.read',
  object: { _id: created.object[0]._id }
})

await db.close()
```

See [CRUD and hierarchy](#crud-and-hierarchy) for the full API and configuration details.

---

## AI-Native Data Intelligence

**AI shouldn't have to search blindly through an entire database to find what matters.**

CoCreateDB's local-first execution and independently accessible indexes create a foundation for integrating AI directly with database operations.

Authorized AI agents can potentially use database primitives to:

- Discover available keys and data structures.
- Inspect index metadata and value ranges.
- Identify relevant objects before retrieving them.
- Execute structured queries.
- Analyze and transform documents.
- Perform permitted create, read, update, and delete operations.
- Coordinate data workflows across distributed infrastructure.

In the Data Ocean vision, AI can use metadata to determine what information is needed while CoCreateDB handles indexing, location, and retrieval.

AI-native integration is an architectural direction, not a claim that a language model or autonomous agent is bundled with the engine. Access must remain permission-controlled.

---

## Rich Document Operations

CoCreateDB uses a JavaScript-oriented data model:

**Storage → Database → Array → Object → Key**

Objects support nested structures and dot-notation paths such as:

``` javascript
"user.location.country"
```

### Query Operators

| Category | Operators |
| --- | --- |
| Comparison | `$eq`, `$ne`, `$lt`, `$lte`, `$gt`, `$gte` |
| Logical | `$and`, `$or`, `$nor`, `$not` |
| Membership | `$in`, `$nin` |
| Arrays | `$all`, `$elemMatch`, `$size` |
| Elements | `$exists`, `$type` |
| Patterns | `$regex`, `$options` |
| Numeric | `$mod` |

Example query expression:

``` javascript
{
  status: "active",
  age: { $gte: 18 },
  "user.location.country": "Costa Rica"
}
```

### Updates and Deletes

CoCreateDB's mutation utilities support direct assignments, nested paths, and structured operators.

| Category | Operators |
| --- | --- |
| Fields | `$rename`, `$unset`, `$delete`, `$inc` |
| Arrays | `$push`, `$each`, `$splice`, `$pop`, `$shift`, `$pull`, `$addToSet`, `$slice` |

Example update expression:

``` javascript
{
  $inc: { views: 1 },
  $push: { tags: "database" },
  $unset: { "user.temporary": true }
}
```

Object-level deletion is distinct from removing fields or array elements.

CoCreateDB uses MongoDB-inspired syntax; exact compatibility and index-backed execution depend on the operator and implementation.

---

## Indexing at the Core

**The index is not just a performance feature. It is a foundational database primitive.**

CoCreateDB organizes indexes into independently addressable segments.

Index metadata can include:

- First and last indexed values.
- Entry counts.
- Object identifiers.
- Previous and next segment references.
- Hierarchical references for larger indexes.

This structure allows the engine to navigate relevant portions of an index instead of loading every indexed value.

Query planning can use index metadata to narrow candidate objects and reduce unnecessary reads.

The same independently accessible indexing architecture provides a foundation for AI-assisted data discovery and distributed storage navigation.

---

## Memory-First Execution and Persistence

CoCreateDB processes data in memory and returns CRUD results as soon as the
requested data and operation result are ready. Durable reads and writes are
mediated by the configured persistence workflow; the core does not prescribe a
fixed filesystem/peer/provider retrieval order. The workflow decides which
storage operations to run and in what order.

The current prototype still contains direct filesystem paths and persistence
flags. Those are implementation gaps against the persistence architecture in
[`specifications/persistence.md`](specifications/persistence.md), tracked in
[`NEXT_TASK.md`](NEXT_TASK.md).

### Storage-Agnostic Design

CoCreateDB separates query execution, indexing, in-memory data operations, and
persistence. All durable storage operations pass through the persistence
workflow. The workflow may use local filesystems, object-storage providers,
external databases, or custom providers.

Native objects, indexes, and metadata can be persisted as independently addressable structures, supporting selective retrieval and potential restoration without rebuilding all indexes.

### Deferred Writes

Persistence runs after the CRUD response. `db.flush()` may drain pending DB and
workflow work, but it does not independently establish crash durability or
multi-artifact atomicity.

---

## Distributed by Design

CoCreateDB's distributed architecture envisions multiple nodes performing local operations and synchronizing changes asynchronously.

The design favors eventual consistency for suitable workloads.

Its goals include:

- Local-first reads and writes.
- Peer synchronization.
- Distributed data placement.
- New-node bootstrap.
- Timestamp-based mutation reconciliation; see the focused specifications below.
- Configurable persistent storage.

Mutation execution, conflict precedence, peer propagation, and persistence are
defined in [`specifications/`](specifications/). The timestamp-based
reconciliation contract and its implementation gaps are documented there and
tracked in [NEXT_TASK.md](NEXT_TASK.md). Recovery and durability guarantees must
be verified before production use.

---

## Performance: CoCreateDB vs. MongoDB

Preliminary direct-call benchmarks measured CoCreateDB running in-process against MongoDB accessed through its Node.js driver.

### Read and Write Latency

| Operation | CoCreateDB | MongoDB | Difference |
| --- | ---: | ---: | ---: |
| Read by ID | **0.950 ms** | 1.747 ms | 45.6% lower |
| Equality query | **0.645 ms** | 1.758 ms | 63.3% lower |
| Range query | 3.930 ms | **3.457 ms** | 13.7% higher |
| Create | **0.788 ms** | 1.737 ms | 54.6% lower |
| Update | **0.515 ms** | 2.206 ms | 76.7% lower |

CoCreateDB recorded lower measured latency in four of the five operations shown.

The CoCreateDB figures reflect its latest reported measurements. MongoDB values are from an earlier comparison run, not a newly rerun matched test.

### Deferred Persistence

| Operation | CoCreateDB |
| --- | ---: |
| Deferred create | 12.753 ms |
| Deferred update | 0.404 ms |
| Flush after create batch | 62.165 ms |
| Flush after update batch | 9.167 ms |

Flush times represent batch completion measurements, not per-object latency.

### Benchmark Conditions

The tests used 1,000 seeded documents and averages of three subsequent calls after a separately measured first call.

CoCreateDB operations executed in-process; MongoDB operations included driver and network communication with write concern `{ w: 1, j: false }`.

These measurements are preliminary, are not durability-equivalent, and do not establish universal performance superiority. Delete performance was not measured in this comparison.

---

## Lightweight by Design

Reported implementation measurements:

| Metric | Measurement |
| --- | ---: |
| Source files | 29 |
| Lines of JavaScript | 5,703 |
| Source content | \~267 KiB |
| External runtime dependencies | 0 reported |
| Incremental JavaScript heap | \~3.2 MiB |
| Incremental resident memory | \~22 MiB |

Memory measurements compare an empty Node.js runtime with an initialized, empty CoCreateDB instance.

Source size is not the npm package size, and production memory usage depends on workload and cache configuration.

---

## Is CoCreateDB Right for You?

CoCreateDB is designed for developers seeking an embeddable JavaScript document database with rich queries, independent indexing, memory-first performance, and flexible persistence.

It is particularly attractive when reducing infrastructure dependencies and controlling data placement are priorities.

Applications requiring mature distributed transactions, strict global consistency, established enterprise tooling, or specialized analytical engines should verify that CoCreateDB satisfies those requirements before adoption.

---

## Project

**CoCreateDB** is an independent database engine within the CoCreateJS ecosystem.

- **GitHub:** [CoCreateJS/db](<https://github.com/CoCreateJS/db>)
- **npm:** `@cocreate/db`
- **Language:** JavaScript
- **Primary runtime:** Node.js
- **Database model:** NoSQL documents
- **Core architecture:** Independent segmented indexes, memory-first execution, storage-agnostic persistence


---

## The Future of Data Is Not Tied to One Location

CoCreateDB combines a practical JavaScript document database with a larger vision for distributed, intelligent data infrastructure.

**One Database Engine. Any Runtime. Any Storage.**

**An Intelligent Data Ocean—where data is active when needed, persistent when idle, and discoverable wherever it lives.**

---

*Performance figures are preliminary November 2026 measurements. Runtime compatibility, storage adapters, distributed behavior, and production guarantees should be verified against the current implementation.*

# CoCreateDB

CoCreateDB (`@cocreate/db`) is CoCreate's memory-first database engine. The
current prototype uses filesystem persistence; the target routes durable
operations through the persistence workflow.
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

The logical hierarchy is organization namespace → storages → databases → arrays → objects.
Nested storages/databases are not implemented. Metadata, objects, field indexes,
and terminal array values have their own files. Organization and entity IDs are
24-character ObjectIds. Records have separate immutable UUID file addresses;
`_id` stays inside the record as an indexed public value.

The following tree documents the current prototype's local filesystem layout.
It is not the target storage execution model: the persistence specification
routes all durable operations through a workflow, and the workflow owns provider
paths and I/O.

```text
<directory>/<organization_id>/
  root.json                       # permanent storage-catalog entry point
  indexes/<indexId>.json           # catalog and field-index partitions
  storages/<fileUUID>.json
  databases/<fileUUID>.json
  arrays/<fileUUID>.json
  objects/<fileUUID>.json
  keys/<keyId>.json            # named terminal-array key records
  deleted/<deletionId>.json
  distribution/...                # local inventory only
```

The root points to the storage catalog. Storage, database, and array metadata
carry an `index` reference to their child catalog. Index leaves map field values
to file UUIDs. Catalogs use the same recursive index engine and split during peer
serialization. Empty root/catalog entry points remain available. Rename and update
keep file UUIDs unchanged; the same public `_id` may appear in different arrays.

### File roles and naming direction

The intended names and relationships for the entry index, index nodes,
distribution map, data artifacts, and logical scopes are defined in
[`specifications/architecture.md`](specifications/architecture.md). The current format
still uses `root.json` and its existing directories; migration to the specified
layout requires a separate, explicit compatibility plan.

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

The options shown above describe the current prototype. Its `disk`,
`memoryOnly`, `memoryCache`, `writeBehind`, and `COCREATE_DB_DIRECTORY` behavior
is being aligned with the persistence workflow specification. In the target
design, provider and filesystem path configuration belong to the workflow; the
core has no direct-disk bypass or storage destination flag.

In the current prototype, files are loaded on demand, not eagerly at startup.
DB-owned values remain live
references; callers should not mutate supplied/returned values outside DB APIs.
With the server's default write-behind mode, object create/update acknowledges
the owned in-memory value. Object delete acknowledges removing that owned value,
with a memory-only lifetime guard in the current implementation. The agreed
mutation policy below removes stale-generation checks; this implementation gap is
tracked in [NEXT_TASK.md](NEXT_TASK.md). Reads return the available data
after query evaluation, sorting, pagination, and projection. They do not wait for
pending indexing or a coordinated snapshot; later subscribed events propagate
subsequent changes. Counters, availability, index reconciliation, client
registration messages, peer delivery, and disk persistence continue afterward.
Pending documents remain visible to reads. Peer network waits do not hold the
primary memory-operation queue; structural splits still run under that queue.
Already completed success responses are not changed by backend failures, which
remain visible in `persistenceStats()`. Explicit write-through mode remains
synchronous for local tools. `flush()` drains indexing, delivery, and queued writes;
`close()` flushes before closing.
An acknowledgment is not crash durability until those disk writes finish.

API errors accumulate in `data.error` arrays and set `success: false`. Background
DB delivery failures remain inspectable through `persistenceStats().backgroundError`.
DB API failures do not write console logs. Workflow errors likewise accumulate on
the payload being processed; workflow invocation needs no `internal` flag.

## Read resolution and acquisition

Each request retains resolved catalog names, IDs, and live record references in
a temporary context. CRUD, counter updates, distribution, peer publishing, and
recovery reuse those references instead of resolving the same record again.
The context uses plain objects/arrays and Node's async request scope; it is never
persisted or placed in a CRUD response. Rename/delete/recreation invalidate the
affected references. Queued index work retains its originating context until it
finishes; independent server requests start separate contexts. The normal shared
cache remains a separate lifetime and policy.

The existing lookup order is memory → disk → known peer holders. Missing index
partitions are requested by path; complete records can be requested by scoped
entity ID. Disk text is parsed by file I/O and network JSON by the transport.
Peer acquisition receives parsed values. The persistence boundary additionally
accepts JSON strings and parses them before installation.

Acquired partitions and records are made available in memory for the requested
query. Availability bookkeeping and recovery indexing follow the response; local
cache writes follow `disk` and write-behind settings. Acquisition does not publish
a new user mutation. A read response never waits for unrelated backend work once
its result is prepared, and a backend failure cannot retroactively change it.
Metadata discovery and object retrieval have separate paths: this is not yet one
uniform resolver for every CRUD target. An advertised partition whose holders
cannot supply it produces an error. File-level persistence-workflow fallback is
not wired yet.

## Specifications

[`specifications/README.md`](specifications/README.md) is the catalog and defines
the runtime `index.json` entry point. The focused specifications cover the
overall structure, scopes, field indexes, data artifacts, distribution,
CRUD request and response flows, mutations, reconciliation, replication, and
persistence. Each behavior has one authoritative definition; current
implementation alignment is listed in [`NEXT_TASK.md`](NEXT_TASK.md).

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
stored whole in flat `keys/` records outside index nodes, with the field name,
owning record UUID, catalog ID, and live array value. Query
matching uses shared utilities; nested array-member queries can require scans.
Custom index definitions and uniqueness constraints are not implemented.

Automatic index nodes are sibling files under `<organization_id>/indexes/`.
Their logical tree still follows node IDs. Catalog roots have stable 32-character
IDs derived from their organization-relative namespace address, so they can be
resolved from `root.json` and parent metadata without a directory scan. Each node references
its catalog; the catalog retains its logical namespace path for cold traversal.
Peer partition addresses are `<organization_id>/indexes/<indexId>.json` and do not
require storage/database/array routing. Deletion walks the affected catalog tree;
it never removes another scope's indexes. Local distribution retains its layout.

This is an on-disk and peer-wire format change. Existing datasets require
migration; DB rejects unversioned data before writing new roots. This
change does not migrate or modify an existing live data directory. `flat: false`
is reserved for the existing local distribution indexes, not automatic indexes.


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
        path: '.../indexes/<indexId>.json',
        value: { /* complete parsed file contents */ }
    }]
}
```

Persistence create/read/update/delete are workflow input operations, not separate
provider methods in DB. Persistence return values may be parsed objects or JSON
strings. The boundary parses strings and observes their UTF-8 size as `$bytes`;
parsed objects retain their references and any existing observation without being
encoded for measurement. Envelope size is not attributed to individual files.
Malformed JSON accumulates a safe error on the request's `error` array, with
`success: false`, and is not installed. The current recovery bridge applies this
to returned records; the retained workflow hook also normalizes responses without
enabling file-tree reads or external writes. `$bytes` is reserved metadata, excluded
from automatic indexes and ordinary field-to-patch generation. It is a last-read
observation, not a promise of the current in-memory or persisted file size.
File acquisition still needs local caching when disk is enabled.
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
