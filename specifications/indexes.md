# Indexes

## Current runtime structure

Each indexed key has a Map of value-type trees, not one mixed-type tree. UUID is excluded from ordinary indexing and resolved directly through the artifact Map. Scalar flattened keys, including scope and parent, are indexed. Entries hold the original object, key, tree and partition references. Equal values group entries ordered by UUID.

Tree leaves hold `[value, entries]` groups; branches hold child partitions. Partition metadata includes firstValue, firstUuid, lastValue, lastUuid and length. Default size is 64. Insert splits oversized partitions; removal prunes empty partitions and collapses single-child roots. Moves can reuse entries. Partitions have no persistent identity.

Query selection uses an available compatible equality/range index with the smallest root length, scans bounded candidates and verifies against shared queryData. Without a usable candidate it scans local artifacts. UUID queries use direct lookup. Sorting and search are not implemented. Pagination applies to local matches. Do not infer global coverage from local trees.

## Requirements and optimization targets

Maintain index consistency when values change, preserve type fidelity, avoid duplicate candidates and verify nested predicates. Mixed-type unified trees, richer container/binary semantics and stronger planner guarantees require additional implementation and tests. Current CRUD update clones and reconciles state; reducing traversal and allocation is a future optimization. Runtime indexes rebuild from data, not separately persisted segments.
