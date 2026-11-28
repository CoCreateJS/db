# CoCreateDB source architecture

The public entry is `import DB from '@cocreate/db'`, followed by
`await DB.init(server, options)`. The initialized DB exposes only `config`,
`organizations`, and `send`. `db.organizations.get(id)` resolves or creates
that organization's Tree. `db.send(payload)` selects its Tree and invokes
`tree.execute(payload)`.

`src/index.js` defines the public interface. `runtime.js` contains internal
composition, organization routing, configuration defaults and local telemetry policy. Those runtime methods are not exported by the
package. The package also exports `Tree` for standalone instances.

## Tree composition

```js
import DB, { Tree } from '@cocreate/db'

const db = await DB.init(server, options)
const tree = await db.organizations.get(organizationId)
await tree.execute(payload)

const temporaryTree = new Tree()
temporaryTree.disk = disk
temporaryTree.persistence = persistence
await temporaryTree.init({ roots, indexes, leaves, size, leafSize })
```

Tree exposes `init`, `config`, `leaves`, `disk`, `persistence`, `planner`,
`execute`, `setDiskFirst`, `persist`, and `close`. Organization owns `roots`
and `harvest({ uuid, limit })`, which removes whole Trees from its registry.
`organizationId` identifies its storage namespace. Size, leaf size, and the
current disk-first flag are read through `tree.config`. That configuration is
a snapshot; root edits use `organization.roots.execute({ operation: 'set', path, data })`.

`tree/execute.js` is a stateless function used as `tree.execute(payload)`.
It resolves identities, verifies complete queries, and applies operations to
live leaves. `tree/planner.js` is a stateless function used as
`tree.planner(branch, query, filter)` and describes index intersections, unions, residual predicates, ordering and pagination. `tree/query.js` executes that plan before fetching selected document payloads.
Both functions can be replaced directly on a Tree. An execution wrapper can
retain the default function and invoke it with `execute.call(this, payload)`.
No CRUD or planner instance or factory is needed.

Traversal, mutation helpers, queue counters, branch lookup, and external read
wiring are private implementation details. Execution and test/benchmark
instrumentation access the internal context in `tree/internal.js`. They are
not part of the package's public API.

## Storage and lifecycle

Tree owns disk and persistence ports; a resource exposes `execute(request)` and `queue`.
Without an attached resource, writes and deletes return the request, reads
return `undefined`, existence checks return `false`, and lists return `[]`.
These default responses do not establish durability or enable disk-first mode.

Tree maps local leaf, branch, and configuration operations into file paths.
The organization ID prefixes those paths. Persistence receives logical leaf
reads and serialized leaf/branch/config changes after indexing;
configuration writes carry data. The attached
adapter chooses its own grouping and storage policy.

Mutations acknowledge the memory change before background work completes.
The indexer reconciles changes and sends serialized leaves, branches and
configuration independently to both adapters. There is no public flush API or deferred-index
option. `tree.close()` completes outstanding work. An organization Tree's
close also removes it from the DB runtime's map. `tree.persist()` delegates to
an optional `persist()` method on the attached persistence adapter.

The composer consumes Telemetry's node-wide `memory.max` percentage. At 75% it starts harvesting; harvesting stays active until usage reaches 50%. It selects the lowest-weight eligible primary branch across the managed organization Trees. A primary branch represents an entire table, potentially containing nested tables. Removal releases its resident index trees, descendant branches and leaves together. Stored files and configuration UUIDs remain available for hydration.

Active-operation counts and queued/in-flight indexing protect the entire affected subtree. Counts release on completion, errors and early query-stream closure. A group becomes eligible only after leaf writes, index reconciliation, branch/configuration writes and attached Persistence responses have completed. Completing a 1,024-leaf batch does not complete a larger group. Index completion requests another harvesting pass while pressure remains active; it does not bypass weight ordering. Harvesting does not drain the index queue or wait for busy tables. Memory-only Trees retain their only copy; this implementation requires local Disk for whole-table removal and hydration. Persistence notifications alone do not establish a reloadable local index.

Primary-group weight counts access through that group, including access through nested groups. There is no LRU strategy, terminal-branch ranking, per-stage cleanup or automatic 90% disk-first transition. `tree.harvest({ uuid, limit })` uses the same whole-primary-group removal path; UUID selects a primary group and the optional limit counts groups. A standalone Tree's composer decides when to invoke it. Explicit disk-first mode also releases completed groups through this path. Traffic routing, backoff and emergency node protection remain outside DB.

Each instance executes locally and owns its Trees and indexing. Storage queues belong to adapters. The host initializes
DB in workers and owns network affinity. DB does not forward requests or
coordinate execution across processes.

## Pending index groups

The queue uses plain objects keyed by parent branch UUID and leaf UUID. A
parentless leaf uses its own UUID as the group. Records contain `operation`
and an array of changed `paths`, or `null` for full reconciliation. Changes to
a queued leaf merge into its record. Each cycle handles up to 1,024 leaves;
field/type entries are grouped during reconciliation.

The manager's internal `pendingIndex.toJSON()` combines queued and in-flight
metadata without serializing live leaves. Delete cleanup retains live index
references separately until completed. Shutdown logging and replay are not
implemented by this metadata format.

## Node memory policy

```js
const db = await DB.init(server, {
    memory: { harvestAt: 75, retainAt: 50 }
})
```

The composer applies this policy across all managed Trees. Telemetry provides
machine memory usage, independently of the DB's size. Primary groups own their
field/type indexes; the runtime catalog records `primary`, `key`, `type` and
root `uuid`. There is no compatibility path for the previous shared index or
terminal-branch pruning format.

## Filter contract

```js
await tree.execute({
    storage: 'main', database: 'app', array: 'contacts', method: 'object.read',
    filter: {
        query: { color: 'blue', score: { $gte: 20 } },
        sort: [{ key: 'score', direction: 'desc' }, { key: 'name', direction: 'asc' }],
        index: 0,
        limit: 50
    }
})
```

`startingIndex` can supply the offset instead of `index`; it takes precedence.
`limit: 0` means unbounded. The response reports the applied offset in
`filter.startingIndex` and the next offset in `filter.index`. `isFilter: false`
disables the filter. Unsupported index predicates and container sorts use
shared Utils on candidate documents; those cases can hydrate more than the
final page. Covered, settled scalar predicates are evaluated only in indexes.

Cold reads do not schedule indexing. Stored branch entries hydrate as values
and UUIDs; only selected document payloads are fetched. A mutation lazily
attaches its old affected index entries before the usual reconciliation path.
See [the index contract](../specifications/indexes.md) for coverage and
consistency boundaries.

## Storage resources

Disk and Persistence expose `execute(request)` and `queue`. The indexer sends resolved serialized changes independently to both. DB maps paths and observes completion; adapters own pending/in-flight entries, coalescing, cancellation and I/O. There is no `tree/disk.js` queue implementation. See [the storage contract](../specifications/persistence.md).
