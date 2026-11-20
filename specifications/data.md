# Data and living artifacts

## Current

Artifacts are ordinary JavaScript objects with a live prototype, UUID, scope and optional parent. Structural artifacts also have a name. UUID is globally unique within an engine instance, not a filename or a tenant-local address. `_id` is a separate object identity (generated for object creates if omitted). UUID, scope and parent are protected; structural name is immutable. CRUD update also protects `_id`.

Creation attaches methods to the input object. Read and create results can expose live references. Use CRUD or supported artifact methods (`getValue`, `setValue`, `getIndex`, `delete`) to maintain indexes; direct assignments bypass maintenance. Artifact.delete(key) removes a key, not a whole artifact. CRUD delete removes the artifact and its index entries.

Index entries reference the original artifact and its key. Runtime tree nodes have no artifact UUID. The configured index scope is an ordinary scope, distinct from internal runtime trees.

Current data support is scalar leaves (finite numbers, strings, booleans, null) via shared path flattening. Nested containers can hold supported leaves; full binary, sparse array, undefined and container-index semantics are not guaranteed. Unsupported values and unsafe keys must not be silently coerced. Broader fidelity is planned.

Configuration restores structural names and addresses only. Complete data hydration, eviction distinct from logical deletion, and external serialization remain integration requirements. No durable storage is mandatory.
