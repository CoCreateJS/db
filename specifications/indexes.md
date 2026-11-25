# Indexes

## Current runtime structure

Each indexed key has a Map of value-type trees, not one mixed-type tree. UUID is excluded from ordinary indexing and resolved directly through the leaf Map. Scalar flattened keys, including root and parent, are indexed. Entries hold the original object, key, tree and branch references. Equal values group leaf references ordered by UUID.

Offloaded terminal branches are stored under `branches/`; data leaves are stored under `leaves/`. A terminal branch holds `[value, leafReferences]` groups, while a nonterminal branch holds child branch references. The root and parent branch catalog is not yet restored on restart. Branch metadata includes firstValue, firstUuid, lastValue, lastUuid and length. The default capacity is 1,024 leaf entries per terminal branch and 1,024 children per nonterminal branch. The `leafSize` option controls leaf-entry capacity independently. Insert splits oversized branches; removal prunes empty branches and collapses single-child roots. Moves can reuse entries. Branches have no persistent identity beyond their UUID.

Query selection uses the smallest usable scalar index and verifies candidates with shared queryData. A range scans the matching type index first when the bounds have that type, then checks leaves outside that index for matches under JavaScript coercion. Coverage includes Hot and Warm leaves and accounts for pending index changes. The fallback can inspect a Warm leaf’s index entry before loading its payload. Queries without a usable index scan local leaves. UUID queries use direct lookup. Sorting and search are not implemented. Pagination applies to local matches. Do not infer global coverage from local trees.

## CRUD selection and execution

Create with a supplied UUID, read, update, and delete use the tree's `visitMatches` path. It locates UUIDs directly or scans index candidates, verifies the complete query, and invokes CRUD's operation handler for each match before continuing the same traversal. Mutating operations queue index reconciliation while the traversal is active; the tree applies that work after the visit completes. Create without a UUID keeps the direct staged-insert path. CRUD responses still collect their result values in the response envelope. This is an internal cursor-style traversal, not a public resumable cursor API.

An explicit UUID uses direct lookup. Create without a UUID follows the staged insert path and does not perform an existence lookup for its generated UUID; a supplied UUID is checked before it is reserved. Create and upsert keep their distinct duplicate/create semantics even though they share leaf insertion primitives.

## Requirements and optimization targets

Maintain index consistency when values change, preserve type fidelity, avoid duplicate candidates and verify nested predicates. Mixed-type unified trees, richer container/binary semantics and stronger planner guarantees require additional implementation and tests. Current CRUD update clones and reconciles state; reducing traversal and allocation is a future optimization. The runtime index catalog is rebuilt from data; the root/parent branch catalog is not yet persisted for restart recovery.

## Local residency pressure

Adaptive mode is the default. At startup, the default requested allocation is 25% of total system memory. The effective soft RSS budget is the smaller of that allocation and memory available to the OS at startup (Linux `MemAvailable`, falling back to the OS free-memory value). This target guides CoCreateDB's Hot/Warm residency; it is not a hard cap on total process RSS or an ingress safeguard. Each completed CRUD request samples process RSS against this budget. Below 90% of budget, eviction passes start at most every 100 ms by default, with internal thresholds at 10%, 20%, 30%, 40%, 50%, 60%, 80%, and 90%. Each pass evicts the complete lowest eligible weight group from both branches and leaves; group size is determined by current weights, not a fixed item count. At or above 90%, each request signals pruning immediately. Requests that arrive during a pass share one pending signal, which is cleared when pressure drops below the active threshold with hysteresis.

An index pass selects the complete lowest eligible branch weight group; the leaf pass independently selects the complete lowest eligible leaf weight group. Each tier runs one pass at a time with up to four concurrent writes. At 90% pressure, adaptive request handling temporarily uses disk-first processing. The request can return its in-memory result while the DB writes and sheds local state; the 2.5 percentage point hysteresis returns it to adaptive handling below 87.5%. There is no separate 100% stage: above 90%, each request can signal another weighted pass without a fixed item count. Index scans and explicit branch access increase view weight. Index inserts, updates, and deletes track changes separately. A branch read or modified during its offload is skipped and can be reconsidered in a later pass.

This eviction policy mitigates DB-managed memory growth; it cannot prevent memory consumed by network input, active requests or server-side queues. Total process protection requires server-level telemetry and ingress backpressure.

After a leaf write commits, document index slots reference a shared disk descriptor for that leaf. The routing node remains in the tree for range and neighbor lookup. Reload reconstructs the live entries from the indexed values and document UUIDs in the leaf file, without loading document payloads. A leaf with a pending index mutation keeps its live entries until that mutation is reconciled.
