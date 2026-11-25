# Indexes

## Current runtime structure

Each indexed key has a Map of value-type trees, not one mixed-type tree. UUID is excluded from ordinary indexing and resolved directly through the leaf Map. Scalar flattened keys, including root and parent, are indexed. Entries hold the original object, key, tree and branch references. Equal values group leaf references ordered by UUID.

Offloaded terminal branches are stored under `branches/`; data leaves are stored under `leaves/`. A terminal branch holds `[value, leafReferences]` groups, while a nonterminal branch holds child branch references. The root and parent branch catalog is not yet restored on restart. Branch metadata includes firstValue, firstUuid, lastValue, lastUuid and length. The default capacity is 1,024 leaf entries per terminal branch and 1,024 children per nonterminal branch. The `leafSize` option controls leaf-entry capacity independently. Insert splits oversized branches; removal prunes empty branches and collapses single-child roots. Moves can reuse entries. Branches have no persistent identity beyond their UUID.

Query selection uses the smallest usable scalar index and verifies candidates with shared queryData. A range scans the matching type index first when the bounds have that type, then checks leaves outside that index for matches under JavaScript coercion. Coverage includes Hot and Warm leaves and accounts for pending index changes. The fallback can inspect a Warm leaf’s index entry before loading its payload. Queries without a usable index scan local leaves. UUID queries use direct lookup. Sorting and search are not implemented. Pagination applies to local matches. Do not infer global coverage from local trees.

## CRUD selection and execution

The Tree surface separates direct resource lookup from query candidate selection:

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

`getPrimaryBranch` resolves the configured root and provides the index-bearing
descriptor to the composed planner. The current planner returns one plan with
`strategy`, index `key` and `type`, `min` and `max`, and candidate `branches`.
`tree.getLeaves(plan)` streams those candidates (or local leaves for a scan);
CRUD verifies the complete predicate and applies its operation while consuming
the stream. Mutations defer index reconciliation until traversal completes.
UUID requests use direct `tree.leaves.get(uuid)`. Supplied create UUIDs use
`tree.leaves.has(uuid)` to check resident, Disk, or Persistence records without
hydrating existing leaf data. Create inserts directly under the resolved root.
The planner result shape and more advanced multi-plan behavior are intentionally
left for a separate design pass.

An explicit UUID uses direct lookup. Create without a UUID follows the staged insert path and does not perform an existence lookup for its generated UUID; a supplied UUID is checked before it is reserved. Create and upsert keep their distinct duplicate/create semantics even though they share leaf insertion primitives.

## Requirements and optimization targets

Maintain index consistency when values change, preserve type fidelity, avoid duplicate candidates and verify nested predicates. Mixed-type unified trees, richer container/binary semantics and stronger planner guarantees require additional implementation and tests. Current CRUD update clones and reconciles state; reducing traversal and allocation is a future optimization. The runtime index catalog is rebuilt from data; the root/parent branch catalog is not yet persisted for restart recovery.

## Local residency pressure

Adaptive mode is the default. At startup, the default requested allocation is 25% of total system memory. The effective soft RSS budget is the smaller of that allocation and memory available to the OS at startup (Linux `MemAvailable`, falling back to the OS free-memory value). This target guides CoCreateDB's Hot/Warm residency; it is not a hard cap on total process RSS or an ingress safeguard. Index listens to primary-server telemetry and owns the pressure stages, hysteresis, and pruning schedule. Each newly crossed stage queues `tree.prune(config.prune)`; branch pruning does not depend on which storage adapters are attached.

`tree.prune({ strategy, limit })` prunes terminal branch contents only; leaves are not candidates. The default strategy is LFU, ranked by branch `weight`; LRU ranks by `lastVisited`. `limit` is the maximum number of branches to prune, and an omitted limit means all eligible branches. Pruning flushes pending index work, preserves routing paths, and skips branches touched or modified during an asynchronous offload. When attached, local Disk and Persistence each receive a branch write before Tree releases its contents. Without local Disk, Tree rebuilds the pruned branch from resident leaf index entries on demand; reading persisted branches is not yet implemented. At 90% pressure, adaptive request handling can also temporarily use disk-first processing; the 2.5 percentage point hysteresis returns it to adaptive handling below 87.5%. This only affects request residency and does not define the prune strategy.

This pruning policy mitigates DB-managed memory growth; it cannot prevent memory consumed by network input, active requests or server-side queues. Total process protection requires server-level telemetry and ingress backpressure.

After a leaf write commits, document index slots reference a shared disk descriptor for that leaf. The routing node remains in the tree for range and neighbor lookup. Reload reconstructs the live entries from the indexed values and document UUIDs in the leaf file, without loading document payloads. A leaf with a pending index mutation keeps its live entries until that mutation is reconciled.
