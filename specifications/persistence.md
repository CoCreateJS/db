# Persistence contract

Persistence is a Tree resource, separate from local Disk. Compose it through
DB initialization or assign it directly to a standalone Tree:

```js
import DB from '@cocreate/db'

const db = await DB.init(server, { persistence })
const tree = await db.organizations.get(organizationId)
tree.persistence = persistence
await tree.persist()
```

The adapter exposes `execute(request)` and can optionally expose `persist()`.
Tree's `persist()` delegates to that adapter method; the adapter owns timing,
grouping, storage mapping and provider selection. Tree has no persistence
journal and no Workflow dependency.

## Operations

```js
{ operation: 'read', kind: 'leaf', uuid, organization_id }
{ operation: 'write', kind: 'leaf', uuid, organization_id }
{ operation: 'delete', kind: 'leaf', uuid, organization_id }
{ operation: 'write', kind: 'branch', uuid, organization_id }
{ operation: 'delete', kind: 'branch', uuid, organization_id }
{ operation: 'write', kind: 'config', data, organization_id }
```

The organization property is included when assigned to the Tree. Leaf reads
can acquire missing data from the adapter. After indexing and local writes,
Tree notifies persistence of changed leaf and branch UUIDs; these notifications
do not carry live object snapshots. Configuration writes carry serialized `data`. Pruning does not send additional persistence writes; it waits for the existing indexing/storage lifecycle.

Tree awaits adapter responses. An adapter can stage its own work and respond
promptly, or complete storage before resolving. Without an adapter, the default
port returns write/delete requests and returns `undefined` for reads. Those
responses complete the call without establishing external durability.

A separate Tree can be initialized with an organization's configuration and
independently composed storage adapters. Its configuration and lifetime belong
to its composer.
