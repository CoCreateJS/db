# Architecture

## Composition and ownership

`import DB from '@cocreate/db'` and `await DB.init(server, options)` expose only
`config`, `organizations`, and `send(payload)`. Standalone, combined primary/worker,
and worker forwarding use the same contract. DB owns its primary/worker request
composition over Server's existing `send()` transport.

`db.organizations.get(id)` returns an organization context. The organization owns
its roots configuration, structural identity catalog, and `trees`, a Map from
primary branch UUID to Tree. It resolves the envelope's root references using
configuration before selecting an engine. Existing structural paths require no
Tree or leaf hydration for discovery. Create/upsert can establish missing named
ancestors. Concurrent creation of the same ancestor shares one pending result.

Each primary branch has one independent `Tree`. Its UUID identifies that primary;
its local `roots` describe only the row categories that belong to it. A Tree owns
its leaf Map, field/type indexes, queue, active-operation count and weight. It
has no organization registry, sibling/child Trees, ancestor resolver or shared
organization leaf Map. Nested tables are separate Trees. Structural rows live
in their parent's table, while the organization catalog retains the addressing
information for their child tables. Parentless row categories have primary
UUIDs in `organization.config.top`.

The organization obtains engines through `await organization.getTree(uuid)`.
Initialization is shared for concurrent requests. A standalone engine uses:

```js
const tree = new Tree()
tree.disk = disk
tree.persistence = persistence
await tree.init({ uuid: primaryUuid, parent: primaryUuid, roots: { object: {} }, size: 64 })
await tree.execute({ method: 'object.create', object: { value: 1 } })
```

`execute` and `planner` are shared stateless functions assigned to each instance
and can be replaced. Internal traversal/mutation helpers are not package APIs.
Organization-wide partial queries combine table results before final pagination;
filtered mutations select their page before applying changes. Full-scope requests
execute directly against the selected Tree.

## Residency and pruning

The composer consumes Telemetry's node-wide `memory.max` percentage. At 75% it
starts pruning and remains active until usage reaches 50%. It selects the
lowest-weight eligible Tree across organizations. Weight counts operations on
that Tree; accessing one table does not increment another table's weight.

Active requests and query iterators protect their engine. Pending and in-flight
index records protect it through leaf writes, index reconciliation, branch/config
writes and attached Persistence responses. Partial batch completion does not make
a still-busy Tree eligible. Organization metadata writes also protect routing.
Index/storage completion requests another pruning pass while pressure remains.

`await organization.prune({ uuid, limit })` removes eligible Trees from the
registry. UUID optionally selects one engine; limit counts Trees. Selection
ranks resident engines, but removal itself is one Map deletion. It does not walk
index nodes or leaves, drain busy queues, close an idle Tree, or delete files.
Other nested/neighboring Trees stay independent. Unreferenced graphs become
eligible for JavaScript garbage collection; retained application references can
keep an old Tree/leaf alive. A later request creates a fresh engine using saved
configuration and hydrates only the indexes and documents it needs.

Local Disk is required for eviction in this implementation. Memory-only engines
retain their only copy; Persistence notifications alone do not establish complete
reloadable index storage. Explicit disk-first mode uses the same eligible-Tree
registry removal. `tree.setDiskFirst(true)` marks that engine's residency preference;
its registry-owning composer performs removal. Standalone Tree owners control
retention themselves. Traffic routing, backoff and emergency node protection
remain outside DB.

Independent queues can make progress while another Tree waits for I/O; this does
not introduce worker threads or CPU parallel execution within one JS process.

## Storage lifecycle

Successful mutations acknowledge their in-memory change. Background work writes
leaves/deletions, reconciles queued indexes in batches, writes changed branches
and the Tree config, and notifies Persistence. Repeated changes to a queued leaf
coalesce within its own Tree. There are no public flush endpoints. `tree.close()`
completes outstanding local work; the organization closes its resident engines
and routing writes. A memory acknowledgement does not certify disk durability.

Disk initialization and the base directory belong to the adapter. DB maps logical
storage operations to these paths under the encoded organization directory:

- `config.json`: organization roots, structural identities and top primary IDs.
- `trees/<primary UUID>/config.json`: that engine's local row definitions and index catalog.
- `leaves/<hex encoded leaf UUID>.json`: leaf payloads.
- `branches/<branch UUID>.json`: index nodes.

Leaf/branch files are UUID-addressed; the in-memory ownership boundary is the
primary Tree. A direct UUID request without named scope reads its leaf metadata
to select the owning primary. Supplied ancestry constraints are still checked.
The new configuration layout has no compatibility/migration path for older
organization-wide index catalogs. Existing historical files are not rewritten.

## Integration boundary

Disk and Persistence are replaceable resources exposing `execute(request)`.
Without adapters, empty ports complete calls without storing anything. Persistence
owns provider selection, grouping and timing; `tree.persist()` delegates to its
optional `persist()` method. Browser/Node imports share the same engine; platform
I/O stays in the adapter. OPFS remains origin-scoped and quota-managed.

CRUD, Socket, IPC and Mesh own authorization, transport, recipient awareness and
replication. DB does not open connections, discover peers or promise transactional
snapshots or atomic multi-object batches. See [indexes](indexes.md),
[roots](roots.md), [CRUD](crud.md) and [persistence](persistence.md).
