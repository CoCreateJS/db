# Indexes and query execution

## Stored structure

Each primary branch owns field/type index trees. The configuration catalog records primary UUID, field key, value type and index-root UUID, plus count/bounds for planning. Catalog lookup does not hydrate column roots. UUIDs identify leaves directly. Flattened scalar paths, including explicit array positions, are indexed. Empty arrays and objects have separate type buckets so they remain distinct from absent fields for predicates and ordering.

Stored terminal branches contain indexed values and leaf UUIDs. Routing branches contain child UUIDs, bounds and counts. Reading a branch reconstructs index entries without loading its document payloads. The default routing and terminal capacities are 1,024; `size` and `leafSize` can override them. Splits and removals maintain routing references; configuration preserves the current index-root UUIDs for hydration.

## Planning and selection

`tree.planner(branch, query, filter)` is a replaceable stateless function. The internal primary-branch resolver supplies scoped catalog descriptors without initializing every column. The planner returns one `kind: 'query'` plan containing its target root, primary scope, fields, query expression, sorting and pagination. Expression nodes describe fields, AND, OR, NOT, all/none, or document residuals. There is no compatibility path for the former single-candidate plan.

The internal `getLeaves(plan)` executor evaluates index values and UUIDs. AND intersects identity sets, OR unions and deduplicates, and NOT/NOR use the scoped root index as the complement universe. Scalar comparisons use Utils `queryData`; bounds narrow scans only where they preserve its type/coercion semantics. Missing fields and null remain distinct. Covered unsorted plans stream matching UUIDs and probe other indexes, stopping at the page boundary. Explicit sorting collects the necessary candidate values before applying ordering and pagination. Filtered mutations collect matching UUIDs before changing documents so index movement cannot change their own traversal.

For covered queries, multi-field ordering uses indexed values in the order given by `filter.sort`. UUID ascending breaks ties for explicit sorting. Without a sort, results follow the chosen index traversal order. Offset and limit apply after membership and ordering. Only the selected documents are hydrated. Fields and branches unrelated to the query/sort are not initialized merely to describe the primary branch.

Nonempty container predicates, whole-document predicates and search can require residual evaluation through shared Utils. Container sorting may also require document values. Such plans can hydrate additional candidates before filtering/sorting and pagination; they must not claim index-only coverage. Fully covered, settled candidates are not queried against their document payloads a second time.

Reads use the currently indexed view and never drain or wait for indexing. Pending payload mutations may be newer than their indexed entries; those payload predicates are rechecked before returning the document. Ordering is still based on the index view, not a transactional snapshot. Unindexed creates need not appear yet.

## Hydration and mutation

Disk reads bind live leaf behavior and lazy index lookup; they do not enqueue reconciliation. Index-branch restoration creates UUID/value references and only links a document if it is already resident. A cold UUID read does not restore all its columns or neighboring documents. External leaf acquisition can cache the fetched payload to local Disk without adding index work.

Before mutating a cold document, affected old index entries are attached by field value and UUID. Scalar updates resolve only their affected paths. Complex updates and deletion can require all affected old entries. The ordinary queued indexer then removes old positions and inserts new ones. Reading a saved tree does not rebuild it.

## Pruning and active operations

The composer starts pruning at 75% node memory and stops at 50%. Whole primary subtrees are selected by lowest weight. Queued/in-flight indexing includes its local writes and Persistence responses. Active operations are counted on each primary group; an active nested group protects its ancestors from subtree removal. Counts are released in `finally`, including errors and early iterator closure. No second operation registry or read-repair queue is maintained.

A subtree is eligible only when it has no active operations and no unfinished indexing/storage. `tree.prune({ uuid, limit })` uses that same removal primitive and retains saved files/configuration UUIDs. Whole-tree recovery currently requires local Disk; persistence notifications alone do not provide index hydration. Explicit disk-first residency uses the same removal path. Traffic routing, backoff and emergency node protection belong to the surrounding server.
