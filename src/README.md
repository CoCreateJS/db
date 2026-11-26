# CoCreateDB source architecture

The source tree is organized around the active implementation. `src/index.js`
is the single package entry point and composition root. It resolves explicit
configuration and creates the DB runtime. The DB routes requests to an
organization-scoped Tree and composes the Query Planner, CRUD, Persistence,
and disk resources. `db.send()` delegates CRUD work to the selected Tree.

`Tree.persistence` is an optional resource attached by the composition root.
Both `tree.disk` and `tree.persistence` expose a default `execute(request)`
when unattached. Writes and deletes return the request, reads return
`undefined`, existence checks return `false`, and lists return `[]`.
These default responses complete the call without establishing durability.
Tree sends leaf reads to its `execute(operation)` method. After indexing has
written the local leaf and changed branches, Tree notifies the adapter of their
UUIDs and whether each was written or deleted. It does not send leaf or branch
snapshots in those notifications; the adapter owns the queue, grouping, and
storage policy. Tree has no external persistence journal. Without a resource,
it sends no external persistence notifications. Tree owns its `disk`
property, and DB composes it by assigning the initialized Disk resource
directly: `tree.disk = disk`. Tree maps logical leaf, branch and config
operations to provider requests internally. Without an attached resource, Tree
operates in memory.
DB composes persistence by assigning the supplied resource directly:
`tree.persistence = persistence`. A resource may expose `persist()` for an
adapter-owned drain; `db.persist()` delegates to it. The DB does not include a
Workflow integration; Workflow can be composed as an adapter by its host.

DB owns memory pressure policy. It listens to primary-server telemetry,
establishes a baseline from the first valid sample, and uses a default budget of
25% of system memory capped by memory available at that baseline. Each newly
crossed pressure stage queues `tree.prune(...)`. DB passes its pruning
configuration through; the default strategy is LFU regardless of storage.
At 90% of budget, DB also temporarily
enables Tree's disk-first request path; it clears below the hysteresis point.
This is a runtime pressure override and does not rewrite the configured
database mode.

`tree.prune({ strategy, limit })` applies only to resident branch contents.
`limit` bounds the number of branches released; omitting it prunes every
eligible branch selected by the strategy. LFU is Tree's default when called
without a strategy. LRU uses `lastVisited`; LFU uses branch `weight`. Pruning
releases eligible branch contents, while leaving leaf objects resident and
preserving routing paths. When attached, local Disk
and Persistence each receive a branch write before Tree releases its contents.
Without local Disk, Tree rebuilds a pruned branch from resident leaves' index
entries when it is next needed; Persistence branch reads are not yet part of the
recovery path.

## Tree and CRUD boundaries

`tree/` owns root configuration, live leaves, field/type indexes, branch
splitting, range traversal, and the disk operation boundary. DB assigns an
initialized Disk resource directly to Tree, so Tree does not import Node or
browser APIs. Its public structure is:

```js
tree.roots.get(path)
tree.roots.set(path, value)
tree.branches.get(uuid)
tree.getPrimaryBranch(payload)
tree.leaves.get(uuid)
tree.leaves.has(uuid)
tree.getLeaves(plan)
tree.planner(branch, payload)
```

`getPrimaryBranch` resolves the configured root and returns the current
index-bearing branch descriptor used as planner input. The planner returns the
existing single-plan format, and `getLeaves` consumes that plan directly and
streams candidate leaves. CRUD verifies the full query while consuming that
stream. Supplied create UUIDs use `tree.leaves.has(uuid)` to reject collisions
without hydrating existing leaf data. The plan format remains open for a
separate design pass.

`Tree.visitRange(key, type, range, visitor, { mutating: true })` keeps a
single range traversal open while the visitor checks the full query and applies
the requested CRUD operation. Returning `Tree.stop` ends that traversal. Tree
defers index reconciliation until the visitor finishes, so an update or delete
cannot shift the active range underneath the loop.

When local storage is enabled, initialize Disk in the host and pass it as
`server.disk` or `options.disk`. If no disk resource is supplied, the database
stays in memory. A standalone Tree is composed before initialization:

```js
const tree = new Tree()
tree.disk = disk
tree.persistence = persistence
await tree.init({ roots, indexes, leaves, prune, size, leafSize })
```

Mutations acknowledge the live memory change, then the single background
indexer keeps consuming queued leaf changes. It writes dirty leaves before
their derived index branches and root catalog, and yields between bounded
batches so later changes coalesce by leaf. There is no public flush API for
indexing, memory, local storage, or disk; callers do not control this continuous
work loop. `Tree.close()` waits for outstanding work as a lifecycle boundary.
Tests and benchmarks may observe `pendingIndexCount` to coordinate checks
without invoking a flush operation. External persistence policy belongs to the
attached resource. `crud/` and `query-planner/` are independent resources composed by
DB. The planner chooses one index or a full scan, and CRUD verifies the
complete query and applies its operation in the Tree visitor. DB creates the
organization-scoped Tree and composes the planner and CRUD. CRUD depends on
their APIs rather than importing their implementations; these modules do not
depend on DB setup details.

For indexed reads or mutations, CRUD resolves the request root, calls the
composed planner, and passes its plan to `tree.getLeaves(plan)`. The visitor
checks the complete Utils predicate and applies the requested CRUD operation
for each leaf before continuing. UUID requests use `tree.leaves.get(uuid)`. A
create without a supplied UUID skips candidate lookup and inserts directly
into the configured root.

## Pending index groups

The pending queue uses plain objects keyed by the owning parent branch UUID,
then leaf UUID. A top-level leaf without a parent uses its own UUID as the group
key. Each record contains `operation: 'write' | 'delete'` and `paths`, an array
of changed field paths or `null` for full reconciliation. Repeated changes merge
into the existing record. Processing takes up to 1,024 leaves across these
groups per cycle; a group can span multiple cycles. Field/type index entries
are still grouped separately during reconciliation.

The manager's internal `pendingIndex.toJSON()` includes queued and in-flight
records, so they can be serialized without converting Maps, Sets, or live leaf
objects. This is pending-work metadata, not a recovery journal. Delete cleanup
still uses the existing deleted-leaf map for live index references. Shutdown
logging and replay are not implemented here.
