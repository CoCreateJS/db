# Data and living leaves

## Current

Leaves are ordinary JavaScript objects with a live prototype, UUID, root and optional parent. Structural leaves also have a name. Leaf UUIDs are unique within an organization, including across its primary Trees. Each Tree owns only the leaves of its primary. `_id` is a separate object identity (generated for object creates if omitted). UUID, root and parent are protected; structural name is immutable. CRUD update also protects `_id`.

Creation attaches methods to the input object. Read and create results can expose live references. Use CRUD or supported leaf methods (`getValue`, `setValue`, `getIndex`, `delete`) to maintain indexes; direct assignments bypass maintenance. Leaf.delete(key) removes a key, not a whole leaf. CRUD delete removes the leaf and its index entries.

Index entries reference the original leaf and its key. Runtime tree nodes have no leaf UUID. The configured index root is an ordinary root, distinct from internal runtime trees.

Current index values include finite numbers, strings, booleans, null and empty containers, with nested scalar paths flattened by the indexer. Empty containers use distinct type buckets. Nested containers can hold supported leaves; full binary, sparse array, undefined and container-index semantics are not guaranteed. Unsupported values and unsafe keys must not be silently coerced. Broader fidelity is planned.

Configuration restores structural names and addresses only. The engine writes Warm local leaf and branch files for recovery and eviction; this local tier is distinct from Cool external Persistence and Cold archival storage. Complete external data hydration and provider serialization remain integration requirements. Disk initialization chooses the base directory; `disk-cache` clears the attached provider's DB-managed contents at startup.
