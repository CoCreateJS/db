# CoCreateDB source architecture

The public entry is `import DB from '@cocreate/db'`, followed by
`await DB.init(server, options)`. The initialized DB exposes only `config`,
`organizations`, and `send`. `db.organizations.get(id)` resolves or creates
that organization's Tree. `db.send(payload)` selects its Tree and invokes
`tree.execute(payload)`.

`src/index.js` defines the public interface. `runtime.js` contains internal
composition, organization routing, configuration defaults, telemetry policy,
and primary/worker forwarding. Those runtime methods are not exported by the
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
await temporaryTree.init({ roots, indexes, leaves, size, leafSize, prune })
```

Tree exposes `init`, `config`, `roots`, `leaves`, `disk`, `persistence`,
`planner`, `execute`, `prune`, `setDiskFirst`, `persist`, and `close`.
`organizationId` identifies its storage namespace. Size, leaf size, and the
current disk-first flag are read through `tree.config`. That configuration is
a snapshot; root edits use `tree.roots.execute({ operation: 'set', path, data })`.

`tree/execute.js` is a stateless function used as `tree.execute(payload)`.
It resolves identities, verifies complete queries, and applies operations to
live leaves. `tree/planner.js` is a stateless function used as
`tree.planner(branch, query)` and chooses one candidate index or a scan.
Both functions can be replaced directly on a Tree. An execution wrapper can
retain the default function and invoke it with `execute.call(this, payload)`.
No CRUD or planner instance or factory is needed.

Traversal, mutation helpers, queue counters, branch lookup, and external read
wiring are private implementation details. Execution and test/benchmark
instrumentation access the internal context in `tree/internal.js`. They are
not part of the package's public API.

## Storage and lifecycle

Tree owns disk and persistence ports; a resource exposes `execute(request)`.
Without an attached resource, writes and deletes return the request, reads
return `undefined`, existence checks return `false`, and lists return `[]`.
These default responses do not establish durability or enable disk-first mode.

Tree maps local leaf, branch, and configuration operations into file paths.
The organization ID prefixes those paths. Persistence receives logical leaf
reads and notifications of changed leaf/branch UUIDs after local indexing;
configuration and explicit pruning writes can also carry data. The attached
adapter chooses its own grouping and storage policy.

Mutations acknowledge the memory change before background work completes.
The indexer persists dirty leaves before reconciling and storing derived
branches and configuration. There is no public flush API or deferred-index
option. `tree.close()` completes outstanding work. An organization Tree's
close also removes it from the DB runtime's map. `tree.persist()` delegates to
an optional `persist()` method on the attached persistence adapter.

The internal composer consumes primary-server Telemetry's node-wide memory maximum and requests pruning. It uses configured node percentages directly, without an allocation or startup baseline.
`tree.prune()` uses configured defaults; per-call strategy and limit override
them. LFU uses branch weight; LRU uses last visit time. Pruning retains leaves
and releases eligible branch contents. Disk-first can release saved leaves
and their eligible branches after a completed indexing cycle. Without a real
disk adapter, disk-first cannot be enabled.

Workers forward envelopes using the existing Server `send()` transport and
`db.forward` primary handler. Tree instances remain on the primary. A combined
primary/worker instance and standalone DB use local execution directly.

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
    memory: {
        stages: [25, 50, 75, 90],
        diskFirst: 90,
        hysteresis: 2.5
    },
    prune: { strategy: 'lfu', limit: 100 }
})
```

Each upward stage crossing requests a cycle across all managed Trees. The limit
is per Tree; it is not consumed by the first organization. The first telemetry
sample participates immediately. Repeated samples within a stage do not add
cycles. Falling below a threshold minus hysteresis re-arms that stage.
At the disk-first threshold, existing and newly composed Trees use disk-first
retention when local Disk is available. Explicit disk-first configuration is
preserved when usage falls.

All organization Trees created by this DB share the composer's policy. A
standalone Tree has no telemetry listener: its owner can use the same config
and invoke its pruning primitive. Traffic routing, backoff and node coordination
remain outside DB. LFU/LRU branch ranking and the storage/indexing lifecycle
are unchanged.
