# Persistence contract

Persistence is a Tree resource, separate from local Disk. DB composes the
initialized resource directly onto Tree:

```js
const db = await createDB(server, { persistence })
// Composition performed by DB:
tree.persistence = persistence
```

The optional resource must expose `execute(operation)`. It may expose
`persist()` for an adapter-owned drain. The DB does not create a persistence
journal or choose a provider. When no resource is attached, Tree sends no
external persistence operations.

## Operations

Tree sends leaf operations using the same operation envelope:

```js
{ operation: 'read', kind: 'leaf', uuid }
{ operation: 'write', kind: 'leaf', uuid, root, data: leaf }
{ operation: 'delete', kind: 'leaf', uuid, root }
```

When `tree.prune()` offloads a branch, Tree also sends an optional branch write:

```js
{ operation: 'write', kind: 'branch', uuid, data: serializedBranch }
```

Leaf reads are sent when local Tree storage misses and a leaf may be acquired
from external persistence. Leaf writes and deletes are sent as Tree applies
mutations. Leaf write `data` is the live leaf reference. Branch write `data` is
the serialized branch content captured for pruning. If an adapter defers leaf
work and needs a stable revision, it must capture that revision itself. Tree
does not clone, group, queue, retry, or map persistence operations to a provider
format.

Tree awaits `execute(operation)` as part of the operation path. The adapter
chooses how that call completes: it can stage work and return promptly, or
perform its own operation before resolving. Errors and retries belong to the
adapter or surrounding application policy.

`db.persist()` delegates to the attached resource's optional `persist()` method.
With no resource it returns `{ success: false, skipped: true }`; with a resource
that has no `persist()` method it returns `{ success: true, skipped: true }`.
Tree does not inspect adapter queues or results.

## Boundaries

Local Disk and external Persistence remain independent. Disk is Tree's local
storage tier for leaves and derived branches. Persistence is an optional
resource for externally managed storage, grouping, or workflow integration.
Workflow is not built into the Persistence contract.

Tree emits branch writes during pruning and writes root configuration through
Persistence when `tree.roots.set(path, value)` changes it. Tree does not yet read
branches from Persistence. Without local Disk, pruned branches are rebuilt from
resident leaf index entries. A persistence provider that needs a complete
durable Tree must define how branch reads and root configuration are stored and
restored. Inter-node acquisition, distributed ordering, conflict policy,
authorization, retries, and durable acknowledgement are outside this contract.
