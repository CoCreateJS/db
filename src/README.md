# CoCreateDB source architecture

The source tree is organized around the active implementation. `src/index.js`
is the single package entry point and composition root. It resolves explicit or
stored configuration, initializes Tree, and wires the Query Planner, CRUD,
Persistence, and disk resources. `Index.send()` delegates to CRUD; Index does
not contain query planning or operation logic.

`Tree.persistence` is an optional resource attached by the composition root.
Tree sends each leaf read, write, or delete to its `execute(operation)` method.
The attached resource owns any queue, grouping, storage mapping, and provider
policy. Tree has no external persistence journal. Without a resource, it sends
no external persistence operations. Tree owns its `disk`
property, and Index composes it by assigning the initialized Disk resource
directly: `tree.disk = disk`. Tree maps logical leaf, branch and config
operations to provider requests internally. Without an attached resource, Tree
operates in memory.
Index composes persistence by assigning the supplied resource directly:
`tree.persistence = persistence`. A resource may expose `persist()` for an
adapter-owned drain; `db.persist()` delegates to it. The DB does not include a
Workflow integration; Workflow can be composed as an adapter by its host.

Index owns memory pressure policy. It listens to primary-server telemetry,
establishes a baseline from the first valid sample, and uses a default budget of
25% of system memory capped by memory available at that baseline. Each newly
crossed pressure stage queues `tree.prune(...)`. Index passes its pruning
configuration through; the default strategy is LFU regardless of storage.
At 90% of budget, Index also temporarily
enables Tree's disk-first request path; it clears below the hysteresis point.
This is a runtime pressure override and does not rewrite the configured
database mode.

`tree.prune({ strategy, limit })` applies only to resident branch contents.
`limit` bounds the number of branches released; omitting it prunes every
eligible branch selected by the strategy. LFU is Tree's default when called
without a strategy. LRU uses `lastVisited`; LFU uses branch `weight`. Pruning
flushes pending index work and releases eligible branch contents, while leaving
leaf objects resident and preserving routing paths. When attached, local Disk
and Persistence each receive a branch write before Tree releases its contents.
Without local Disk, Tree rebuilds a pruned branch from resident leaves' index
entries when it is next needed; Persistence branch reads are not yet part of the
recovery path.

## Tree and CRUD boundaries

`tree/` owns root configuration, live leaves, field/type indexes, branch
splitting, range traversal, and the disk operation boundary. Index assigns an
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
stays in memory.

`Tree.flushLocal()` completes pending index work before writing dirty leaves,
branches and the index catalog. External persistence policy belongs to the
attached resource. `crud/` and `query-planner/` are independent resources composed by
Index. The planner chooses one index or a full scan, and CRUD verifies the
complete query and applies its operation in the Tree visitor. Index passes the
resolved config to Tree, then injects Tree and the planner into CRUD. CRUD
depends on their APIs rather than importing their implementations; none of
these modules import Index or depend on its setup details.

For indexed reads or mutations, CRUD resolves the request root, calls the
composed planner, and passes its plan to `tree.getLeaves(plan)`. The visitor
checks the complete Utils predicate and applies the requested CRUD operation
for each leaf before continuing. UUID requests use `tree.leaves.get(uuid)`. A
create without a supplied UUID skips candidate lookup and inserts directly
into the configured root.
