# Indexes

## Current runtime structure

Each indexed key has a Map of value-type trees, not one mixed-type tree. UUID is excluded from ordinary indexing and resolved directly through the artifact Map. Scalar flattened keys, including scope and parent, are indexed. Entries hold the original object, key, tree and partition references. Equal values group entries ordered by UUID.

Tree leaves hold `[value, entries]` groups; branches hold child partitions. Partition metadata includes firstValue, firstUuid, lastValue, lastUuid and length. The default capacity is 1,024 entries per leaf and 1,024 children per branch. The `leafSize` option can override leaf capacity independently. Insert splits oversized partitions; removal prunes empty partitions and collapses single-child roots. Moves can reuse entries. Partitions have no persistent identity.

Query selection uses the smallest usable scalar index and verifies candidates with shared queryData. A range scans the matching type index first when the bounds have that type, then checks artifacts outside that index for matches under JavaScript coercion. Coverage includes resident and cold artifacts and accounts for pending index changes. The fallback can inspect a cold artifact’s index entry before loading its payload. Queries without a usable index scan local artifacts. UUID queries use direct lookup. Sorting and search are not implemented. Pagination applies to local matches. Do not infer global coverage from local trees.

## Requirements and optimization targets

Maintain index consistency when values change, preserve type fidelity, avoid duplicate candidates and verify nested predicates. Mixed-type unified trees, richer container/binary semantics and stronger planner guarantees require additional implementation and tests. Current CRUD update clones and reconciles state; reducing traversal and allocation is a future optimization. Runtime indexes rebuild from data, not separately persisted segments.

## Local residency pressure

The configured memory percentage is a soft budget for process RSS. Each completed CRUD request samples pressure. Below budget, eviction batches start at most every 100 ms by default, with thresholds at 5%, 10%, 20%, 40%, 60%, 80%, and 90%. At or above 100%, each request signals pruning immediately. Requests that arrive during a batch share one pending signal, which is cleared if a subsequent sample drops below budget.

An index pass selects the complete lowest eligible index leaf weight group. Artifact payload shedding starts at 80% and can start while a large index group is still being written. Each tier runs one pass at a time with up to four concurrent writes. Index scans and explicit partition access increase view weight. Index inserts, updates, and deletes track changes separately. A partition read or modified during its offload is skipped and can be reconsidered in a later batch. A 2.5 percentage point gap on the way down reduces stage switching near thresholds.

After a leaf write commits, document index slots reference a shared disk descriptor for that leaf. The routing node remains in the tree for range and neighbor lookup. Reload reconstructs the live entries from the indexed values and document UUIDs in the leaf file, without loading document payloads. A leaf with a pending index mutation keeps its live entries until that mutation is reconciled.
