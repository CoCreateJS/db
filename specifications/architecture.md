# Architecture

## Composition and ownership

`import DB from '@cocreate/db'` and `await DB.init(server, options)` expose only
`config`, `organizations`, and `send(payload)`. Tree is also exported for standalone
composition. There is no separate clustered DB API or compatibility execution path.

Each initialized DB instance owns organization routing and all of its Trees.
The host initializes DB in worker processes; DB does not inspect process roles,
forward requests, assign workers or coordinate other instances. Network affinity
and distributed delivery belong to the host.

`db.organizations.get(id)` returns the local organization context, with its roots
schema and structural identity catalog. It resolves a request's primary branch
UUID from configuration and executes against the corresponding local Tree.
Create/upsert can establish missing named ancestors; concurrent discovery shares
pending creation. Each primary branch has an independent Tree, with its own
leaves, indexes, index queue, disk queue, execution and storage resources. Nested
tables remain separate Trees. Primary here identifies a branch, not a process.

`organization.configuration(primaryUuid)` describes an engine without creating
it. `organization.execute(payload)` routes locally, and `organization.harvest()`
removes eligible local engines. Internal runtime diagnostics expose the local
Tree registry and both queue counts; they never wait for queues in CRUD.

A standalone engine remains directly composable:

```js
const tree = new Tree()
tree.disk = disk
tree.persistence = persistence
await tree.init({ uuid: primaryUuid, parent: primaryUuid, roots: { object: {} }, size: 64 })
await tree.execute({ method: 'object.create', object: { value: 1 } })
```

## Instance-local harvesting

Harvesting removes whole Trees. Pruning is reserved for future branch/leaf removal and is not implemented.

Each instance consumes its supplied host's Telemetry `memory.max` percentage.
At 75% it starts harvesting its own lowest-weight eligible Trees; at 50% it stops.
There is no collection of weights, placement registry or pressure broadcast
between DB instances. Standalone hosts without telemetry retain explicit control.

Active requests and query iterators protect their engine. Both pending/in-flight
queues protect reconciliation, local writes and attached Persistence responses.
Storage completion schedules another harvesting pass while pressure remains active.
No secondary leaf cleanup or partial branch eviction is introduced.

Removal is one local registry deletion without traversing indexes/leaves or
deleting files. Saved configuration supports selective hydration into a fresh
engine on later requests. Local Disk is required for eviction; memory-only
engines retain their only copy. Disk-first uses the same eligible-engine removal
lifecycle. JavaScript GC reclaims graphs once references are no longer retained.

## Storage lifecycle

Successful mutations acknowledge the owning instance's in-memory change without
awaiting indexing or storage. Indexing reconciles batched changes, then submits
serialized leaf, branch and configuration requests to Disk and Persistence
independently. Each adapter exposes `execute` and its own `queue`, grouped by
primary UUID into leaves, branches and files. Queue membership covers pending
and in-flight work and determines harvesting eligibility along with active operations,
indexing and outstanding request completions. DB keeps no duplicate storage queue.

Adapters own coalescing and write concurrency. Disk serializes writes/deletes to
the same path and bounds concurrent I/O across groups. A pending request can be
cancelled; a request already taken by the writer finishes normally. The adapters
are independent: neither waits for or triggers the other. Memory acknowledgement
does not certify durability; no public flush endpoints exist.

Organization metadata and engine leaf/index/config writes are owned by the
local DB instance. Disk namespace selection remains the adapter/composer
responsibility; shared-disk coordination is outside this change. The UUID layout under an encoded organization is:

- `config.json`: organization roots, structural identities and top primary IDs.
- `trees/<primary UUID>/config.json`: that engine's definitions and index catalog.
- `leaves/<hex encoded leaf UUID>.json`: payloads.
- `branches/<branch UUID>.json`: index nodes.

Closing drains local work and removes the telemetry listener. Cross-instance
placement, replication, migration and durability coordination remain external work. The configuration layout has no legacy
migration reader.

## Integration boundary

Disk/Persistence expose `execute(request)` and `queue`; empty ports expose an empty map and
complete calls without storage. Persistence owns grouping/timing/provider selection. `tree.persist()`
delegates to its optional `persist()`. Shared browser/Node engines do not import
Node cluster; the existing Server capability supplies transport.

CRUD, Socket, IPC and Mesh own authorization, transport, recipient awareness and
replication. DB does not spawn production workers, open connections or promise
transactional snapshots/atomic multi-object batches. Traffic backoff, admission,
and emergency protection stay outside DB. See [indexes](indexes.md),
[roots](roots.md), [CRUD](crud.md) and [persistence](persistence.md).
