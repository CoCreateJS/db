# Data and living leaves

## Current

Leaves are ordinary JavaScript objects with a live prototype, UUID, root and optional parent. Structural leaves also have a name. UUID is globally unique within an engine instance, not a filename or a tenant-local address. `_id` is a separate object identity (generated for object creates if omitted). UUID, root and parent are protected; structural name is immutable. CRUD update also protects `_id`.

Creation attaches methods to the input object. Read and create results can expose live references. Use CRUD or supported leaf methods (`getValue`, `setValue`, `getIndex`, `delete`) to maintain indexes; direct assignments bypass maintenance. Leaf.delete(key) removes a key, not a whole leaf. CRUD delete removes the leaf and its index entries.

Index entries reference the original leaf and its key. Runtime tree nodes have no leaf UUID. The configured index root is an ordinary root, distinct from internal runtime trees.

Current data support is scalar leaves (finite numbers, strings, booleans, null) via shared path flattening. Nested containers can hold supported leaves; full binary, sparse array, undefined and container-index semantics are not guaranteed. Unsupported values and unsafe keys must not be silently coerced. Broader fidelity is planned.

Configuration restores structural names and addresses only. The engine writes Warm local leaf and branch files for recovery and eviction; this local tier is distinct from Cool external Persistence and Cold archival storage. Complete external data hydration and provider serialization remain integration requirements. A stable base path is needed for local files to survive a restart; `disk-cache` intentionally clears that local base at startup.
