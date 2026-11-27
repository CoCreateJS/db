# Architecture

## Composition and ownership

`import DB from '@cocreate/db'` and `await DB.init(server, options)` expose only
`config`, `organizations`, and `send(payload)`. Tree is also exported for standalone
composition. There is no separate clustered DB API or compatibility execution path.

The primary owns organization routing. `db.organizations.get(id)` returns the
organization context, which owns its root schema, structural identity catalog and
`owners`, a Map from primary UUID to logical worker ID. Root discovery uses this
metadata, without creating or hydrating a Tree on the primary. Create/upsert can
establish missing named ancestors; concurrent discovery shares pending creation.

The coordinator assigns each newly encountered primary UUID to a worker in round
robin order across the available Server worker IDs. Later requests reuse that
assignment. Selection happens once per ownership assignment, not once per request.
Pruning does not remove placement. Rehydration goes to the same owner.

Workers own complete Tree instances: local leaves, indexes, CRUD, planning,
index queues and storage. No worker Tree references another Tree or the primary's
organization catalog. Nested tables remain independent Trees. A structural row
lives in its parent's table; configuration identifies the child table. Parentless
categories have primary UUIDs in `organization.config.top`.

`organization.configuration(primaryUuid)` describes one engine without creating
it. `organization.execute(payload)` routes within that organization, and
`organization.prune({ uuid, limit })` asks owners to prune eligible Trees.
Organization no longer exposes `getTree()` or a resident `trees` Map. Actual
engines live in the execution process's internal store.

A standalone engine remains directly composable:

```js
const tree = new Tree()
tree.disk = disk
tree.persistence = persistence
await tree.init({ uuid: primaryUuid, parent: primaryUuid, roots: { object: {} }, size: 64 })
await tree.execute({ method: 'object.create', object: { value: 1 } })
```

Combined primary/worker instances and standalone `{}` server contexts use that
same execution store locally. A primary with `isWorker: false` only orchestrates;
it never substitutes a local Tree when workers are unavailable. The Server owns
worker availability. Production cluster startup ordering is outside this change;
tests start workers before sending DB requests.

## Existing IPC transport

DB uses Server's existing `send()` and event interface; it introduces no IPC
transport, serialization format, pending-promise map or process management.

- Worker ingress uses `db.forward` to reach the primary router.
- Primary dispatch uses `db.tree`, targeting `worker`, with `primary: false`,
  `broadcast: false`, and `server` restricted to this node.
- The internal command is nested under `tree`; its CRUD envelope is under
  `tree.request`. Keeping organization data off the transport envelope avoids
  IPC's separate organization/socket delivery path.
- First execution carries the primary's local configuration. The worker creates
  and initializes its engine once, then executes. Later execution reuses it;
  the same configuration permits recreation after pruning.

The primary receives ordinary transported values. Live leaf prototypes/references
stay in the execution process. Custom planner/execute functions and initialized
Disk/Persistence resources belong in each execution worker's composition; they
are not serialized from the primary.

Full-scope requests go to one owner. Partial queries coordinate multiple tables
and merge results before final pagination. Supplied UUID uniqueness and unscoped
UUID lookup can consult worker-resident metadata; disk/persistence can identify
cold UUID ancestry. These addressing checks are outside the stateless Tree CRUD.
Multi-table fanout, response serialization and aggregation still consume primary
CPU. A single hot Tree still belongs to one worker. Round robin balances counts,
not measured load; placement migration and other balancing strategies are deferred.

## Worker-local pruning

The primary consumes Telemetry's trusted node-wide `memory.max` percentage. At
75% it sends a pruning-active control to workers; at 50% it sends a stop control.
It does not collect weights or select eviction candidates across workers.

Each worker measures weights and selects its own lowest-weight eligible Trees.
There is no global coldest-Tree guarantee. Between removals it yields for requests
and stop controls. Index/storage completion schedules another local pass while
pressure remains active. No leaf-only cleanup or partial branch eviction exists.

Active requests and query iterators protect their engine. Pending/in-flight index
records protect reconciliation; the independent disk queue protects changed leaf,
branch/config writes and attached Persistence responses. Partial batch completion never makes
a still-busy engine eligible. Workers recheck eligibility before removal.

Removal is one Map deletion, without walking branches/leaves, draining busy queues
or deleting files. Neighboring/nested Trees remain independent. JavaScript GC
reclaims unreferenced graphs; application-held references can retain old graphs.
Local Disk is required for eviction; memory-only engines retain their only copy.
Persistence notifications alone do not establish complete reloadable indexes.
Explicit disk-first residency uses the same eligible-engine removal lifecycle.

Internal `runtime.status()` explicitly requests worker diagnostics, including queue
counts. It is asynchronous across processes and is used by tests/benchmarks.
It is not part of CRUD, does not drain indexing and is not a production weight
reporting protocol. Local runtime queue observation remains synchronous.

## Storage lifecycle

Successful mutations acknowledge the owning worker's in-memory change. The reply
travels back through the primary to the requester without awaiting index/disk
completion. The worker reconciles queued indexes in batches and hands changed
leaves, branches and config to its independent disk queue. Indexing never awaits
that queue. The queue writes leaves, branches and config, applies deletions, then
notifies Persistence. It serializes batches within each Tree, with up to 16 disk
operations across all Trees in one worker.
Repeated index changes coalesce per leaf. Pending disk operations coalesce per
UUID, grouped under the primary UUID as `leaves` and `branches` objects, plus
optional config. File bytes are captured at handoff; the writer does not look
back into live Tree nodes. New changes accumulate separately from an active batch.
A failed write leaves the storage batch pending and surfaces from close; there is
no automatic retry layer. Memory acknowledgement does not certify
disk durability. No public flush endpoints exist.

Organization metadata writes belong to the primary; engine leaf/index/config
writes belong to their owning worker. Initialize resources in each process with
the same DB base namespace. The UUID layout under an encoded organization is:

- `config.json`: organization roots, structural identities and top primary IDs.
- `trees/<primary UUID>/config.json`: that engine's definitions and index catalog.
- `leaves/<hex encoded leaf UUID>.json`: payloads.
- `branches/<branch UUID>.json`: index nodes.

Only one worker owns an engine's writes. Root metadata is not duplicated into
worker-owned organization routers. Closing drains owned work and removes DB event
handlers. Worker loss/reassignment, cross-node ownership, migration and durability
coordination remain external/future work. The configuration layout has no legacy
migration reader.

## Integration boundary

Disk/Persistence expose `execute(request)`; empty ports complete calls without
storage. Persistence owns grouping/timing/provider selection. `tree.persist()`
delegates to its optional `persist()`. Shared browser/Node engines do not import
Node cluster; the existing Server capability supplies transport.

CRUD, Socket, IPC and Mesh own authorization, transport, recipient awareness and
replication. DB does not spawn production workers, open connections or promise
transactional snapshots/atomic multi-object batches. Traffic backoff, admission,
and emergency protection stay outside DB. See [indexes](indexes.md),
[roots](roots.md), [CRUD](crud.md) and [persistence](persistence.md).
