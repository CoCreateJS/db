# CoCreateDB

**A client-server database engine for building distributed databases, built around living leaves, automatic indexing and configurable roots.**

CoCreateDB keeps its working set in memory and can use an attached Disk resource for write-through storage, recovery and pressure relief. Objects retain their identity as they are queried and updated, while index entries reference the objects directly. The engine provides a common CRUD interface for data and structural leaves without requiring an external database provider or network connection. One package entry composes the same engine in both environments and can use `@cocreate/disk` for server filesystem or browser Origin Private File System (OPFS) operations.

CoCreateDB runs as a local database in both browser clients and Node.js servers. CoCreate CRUD and communication layers can connect those database instances into a distributed application. Each instance owns its local Hot/Warm state; the client and server can therefore perform local database work without treating the browser as only a remote UI or cache.

> Development status: this README describes the current Next implementation. The attached Persistence resource receives leaf operations; complete external durability, distributed acquisition and production integration remain separate work. This is not yet a production release.

## Features

- Adaptive Hot-memory and Warm-local-disk residency with direct UUID lookup.
- Automatic indexing of scalar values, including nested keys using dot notation.
- Living leaves and index entries that reference the original object.
- Configurable root hierarchies with dynamic request-driven root names.
- Shared create, read, update and delete operations across configured roots.
- Indexed equality/range queries, AND/OR/NOR selection, multi-field sorting and pagination.
- Update operators through `@cocreate/utils`.
- Transferable structural configuration that preserves root identities.
- Standalone operation and configurable primary/worker forwarding.
- Optional Cool external Persistence and distributed communication through external capabilities, not dependencies of the engine.

## Client-server database model

Application code imports the same `@cocreate/db` entry in both environments. The entry composes Tree, CRUD, query planning, optional Persistence and optional Disk. Tree maps its disk operations to paths; the attached Disk resource performs platform I/O through `execute()`.

| Runtime | Storage and default | Processing model |
| --- | --- | --- |
| Browser client | In-memory unless an initialized Disk resource is attached | Adaptive in-memory by default; disk-first is available with Disk attached |
| Node server | In-memory unless an initialized Disk resource is attached | Adaptive in-memory by default; adaptive Hot/Warm, disk-first and disk-cache modes are available with Disk attached |
| Node worker | Owns assigned Trees and their local storage | Ingress routes through the primary; assigned execution handles CRUD, planning, indexing and writes |
| Node primary with workers | Organization roots and ownership metadata | Routes primary UUIDs round robin to workers, with stable ownership afterward |

The DB engine supplies local CRUD, UUID identity, roots, indexes and residency. Client-server transport, awareness, recipient selection, synchronization and remote acquisition belong to the surrounding CoCreate CRUD, Socket, IPC, Mesh and Workflow layers. They can use the DB instances to build a distributed database, but importing this package alone does not establish connections or replicate changes automatically. See [runtime integration](#runtime-integration) and [the architecture specification](specifications/architecture.md).

## Getting started

Package: [`@cocreate/db`](https://www.npmjs.com/package/@cocreate/db) · Repository: [CoCreateJS/db](https://github.com/CoCreateJS/db)

For the current development implementation, install dependencies from the checked-out Next branch:

```sh
npm install
npm test
```

The examples below use the development source. Once this implementation is published, use the package import `@cocreate/db` instead.

```js
import DB from '@cocreate/db'

const database = await DB.init({}, { prompt: false })
const context = {
    organization_id: 'example',
    storage: 'production',
    database: 'application',
    array: 'products'
}

const created = await database.send({
    ...context,
    method: 'object.create',
    object: { name: 'Keyboard', price: 80, quantity: 10 }
})

const uuid = created.object[0].uuid

const result = await database.send({
    ...context,
    method: 'object.read',
    object: { uuid }
})
```

`send()` returns the CRUD envelope with a `success` flag and an array under the requested root name. The input may be a single object or an array of objects. Check `success` before using the result; failures include an `error` array.

## CRUD operations

### Read

Read by UUID directly, by a named identity, or by a filter:

```js
const result = await database.send({
    ...context,
    method: 'object.read',
    filter: {
        query: { price: { $gte: 50, $lte: 100 } },
        startingIndex: 0,
        limit: 20
    }
})
```

A UUID identifies a leaf directly. Supplied root constraints are still checked. Filters support dot-notation keys such as `profile.name`. A filter limit of `0` requests all local matches. Results describe the local database, not necessarily the complete contents of an external storage provider or cluster.

### Update

```js
const result = await database.send({
    ...context,
    method: 'object.update',
    object: { uuid, '$inc.quantity': 5, price: 90 }
})
```

The update response contains resulting live leaves under `object` and accepted mutations under `$update`. Utils owns the shared operator and timestamp reconciliation semantics.

### Delete

```js
const result = await database.send({
    ...context,
    method: 'object.delete',
    object: { uuid }
})
```

The response contains the leaves actually deleted. Structural leaves with children cannot be deleted until those children are removed.

## Leaves and roots

An **leaf** is a data or structural object with a UUID. A **root** defines its category within a configurable hierarchy. `parent` identifies the immediate parent leaf by UUID; `name` provides a named reference where needed. Roots are not separate storage engines.

The default configuration is:

```js
{
    version: '1.0.0',
    roots: {
        storage: {
            database: {
                array: {
                    object: {},
                    index: {}
                }
            }
        }
    },
    leaves: {}
}
```

The DB composer uses each request's `organization_id` to select or create an organization context. The context resolves the primary UUID from configuration and routes to its assigned execution worker. Organization is not a configured root; the Tree carries `tree.organizationId`, and its Disk paths are rooted under that ID. Other roots beginning with `$` resolve their names from request properties, such as `$tenant_id` or `$project_id`. A dynamic root value names the structural leaf; it does not become its UUID.

```js
const database = await DB.init({}, {
    config: {
        roots: { $tenant_id: { $project_id: { object: {} } } }
    }
})
```

Create and upsert can establish missing ancestors; reads do not create them. Structural identities are recorded in `organization.config.leaves`, independently from ordinary object data. Configuration can be transferred to another engine to reuse structural UUIDs:

```js
const config = (await database.organizations.get(context.organization_id)).config
const replica = await DB.init({}, { config })
```

This restores structural configuration, not the ordinary objects of the original database. Organization configuration snapshots are read through `organization.config`; root definitions use `organization.roots.get(path)` and `organization.roots.execute({ operation: 'set', path, data })`, subject to structural validation. Occupied roots cannot be removed or converted between structural and leaf status. Structural renaming and reparenting are not supported.

## Living leaves and automatic indexing

Each primary Tree maintains its own UUID-keyed leaf Map, field/type indexes, queue and weight. Trees do not share leaves or reference other Trees. Index entries reference their original object rather than storing a second complete copy. Each tree has a root branch and index branches that organize scalar values and support ordered range traversal. Query planning selects an available candidate index and verifies matching objects against the query.

A live leaf internally exposes `getValue`, `setValue`, `getIndex` and `delete` methods through its prototype. Use `tree.execute(payload)` or `db.send(payload)` for supported mutations; direct property assignment bypasses index maintenance. UUID, root and parent are immutable through updates; structural names are also protected.

The index primitives are independently usable from the source modules. Their low-level interfaces are not yet a stable package-level contract. The stateless Tree execution function applies updates through Utils. Ordinary updates mutate live leaves directly; timestamp reconciliation uses cloning only when required by its merge semantics.

## Runtime integration

The public entry is `import DB from '@cocreate/db'` followed by `await DB.init(server, options)`. The returned object exposes only `config`, `organizations`, and `send`. `db.organizations.get(id)` returns its organization context, which owns roots and an `owners` Map from primary UUID to worker ID. The assigned worker owns the actual Tree, including execution, planning, storage ports and lifecycle. Attach an initialized Disk resource as `server.disk` or `options.disk`; otherwise the database stays in memory. Initialization can optionally prompt through `@cocreate/config`:

```js
import DB from '@cocreate/db'

// server is the existing CoCreate Server instance.
server.db = await DB.init(server, { prompt: false })
```

In standalone usage no server is required. When given a worker Server, DB composes its `send()` interface into a primary-forwarding path; a custom `forward(request)` adapter can override that transport. The primary resolves their organization/primary scope and dispatches execution to the owning worker. The `size` option controls index branch sizing.

Local state defaults to `mode: 'adaptive'` with memory acknowledgement. Disk initialization chooses the base directory; Tree adds each organization's directory. `mode: 'disk-cache'` clears the DB-managed base on startup.

The composer consumes Telemetry's node-wide `memory.max`. At 75% the primary tells workers to prune and continues until memory reaches 50%. Each worker chooses its own lowest-weight eligible Trees; weights are not sent to the primary. Active requests and queued/in-flight indexing protect their engine through storage completion. Memory-only Trees retain their only copy.

`await organization.prune({ uuid, limit })` asks owners to remove eligible engines from their local registry. Organization ownership mappings remain stable. It does not traverse their branches or leaves. Nested and neighboring tables stay independent. Saved configuration and files let later requests hydrate only the query's required indexes and payloads into a fresh Tree. Actual memory reclamation occurs through JavaScript garbage collection when references are no longer retained. Clustered execution places Trees in separate worker processes, allowing CPU parallelism across Trees. Combined primary/worker and standalone contexts execute locally through the same engine store. Traffic routing and emergency node protection remain external.

```js
const organization = await database.organizations.get(context.organization_id)
const primaryUuid = created.object[0].parent
const ownerWorkerId = organization.owners.get(primaryUuid)
const config = organization.configuration(primaryUuid)

// Standalone engine for the same primary, with independently composed adapters.
const temporary = new Tree()
temporary.organizationId = context.organization_id
temporary.disk = disk
await temporary.init(config)
await temporary.execute({ method: 'object.read', filter: { query: { price: 80 } } })
await temporary.close()
```

Import the standalone constructor with `import { Tree } from '@cocreate/db'`.
Organization roots are stored in `<organization>/config.json`; each engine's
index catalog is stored in `<organization>/trees/<primary UUID>/config.json`.
Leaf and branch files remain UUID-addressed under that organization. This layout
has no migration path for older organization-wide index catalogs.

The coordinator assigns new primary UUIDs round robin across Server's available
workers, then routes subsequent requests to that stable owner. It uses existing
CoCreate IPC (`db.forward` for ingress and targeted `db.tree` execution), with the
CRUD envelope nested inside the internal request. First dispatch initializes the
Tree in its owner; pruning drops that instance, and a later request hydrates it
in the same worker. An orchestrating primary never creates a local Tree as a
fallback when workers are unavailable. This testing phase assumes workers are
available; production cluster startup ordering and ownership migration are deferred.

One hot Tree remains on one worker. Round robin balances counts, and IPC adds
serialization/routing cost. See [architecture](specifications/architecture.md)
for the execution boundary and [api.js](api.js) for the public interface.

### Browser storage

The shared package entry works in browser contexts; browser consumers import `@cocreate/db` without selecting a separate entry. Initialize Disk with the desired OPFS directory and attach the resource as `server.disk` or `options.disk`. OPFS is origin-scoped, quota-managed browser storage and requires a secure context. On Node, initialize Disk with the desired filesystem directory and attach the resource through the same composition API.

This is local client-side database storage, not an implicit synchronization channel. A host application connects client and server instances using its CRUD and communication setup; distributed delivery and reconciliation remain external to the DB package.

### Persistence and awareness

Persistence is an optional resource assigned directly to Tree. Tree sends accepted leaf mutations to its `execute(operation)` method; the resource decides whether to write immediately or queue/group work. Workflow integration can be composed outside the DB:

```js
const database = await DB.init(server, {
    persistence: provider
})
const organization = await database.organizations.get(context.organization_id)
// Persistence resources are composed in the execution workers.
// A standalone Tree can also delegate through tree.persist().
```

Tree sends the resource logical operations through `execute(request)`. Leaf and branch write/delete notifications contain their UUID and organization ID after indexing completes; configuration writes carry serialized data. The adapter owns grouping and storage policy. `tree.persist()` delegates to its optional `persist()` method. Without an attached adapter, the default port completes the call without storing data.

```text
CoCreate CRUD → CoCreateDB → CRUD workflow / AST
                              ├─ Persistence
                              ├─ Remote CRUD acquisition
                              └─ Communication
```

For successful `object.create`, `object.update`, and `object.delete` requests in adaptive mode, the response follows the in-memory leaf-map mutation. Create assigns or accepts a UUID and adds the leaf; update changes the resident leaf; delete removes it from the resident map and records its pending disk deletion. A generated-UUID create avoids the supplied-UUID existence lookup. Supplied-UUID create, cold-leaf hydration, and query-based operations may need lookup or matching work before the mutation can be acknowledged.

After the response, local background work writes leaf changes, reconciles batched indexes, writes changed branches and the Tree's index catalog, then notifies Persistence. Repeated queued changes to one leaf coalesce. No public flush endpoints exist; `tree.close()` completes outstanding work. Disk-first uses the same acknowledgement and storage lifecycle, then the composer drops eligible Trees. Memory acknowledgement means the mutation was accepted, not that it is already durable. Distributed delivery, retry and recipient management belong to the surrounding application. The DB returns UUID awareness references for that integration.

These integration designs are documented in [persistence](specifications/persistence.md) and [CRUD awareness](specifications/awareness.md). External orchestration, complete acquired-leaf hydration, durable ordering and deduplication are not implemented by this engine checkpoint.

## Tests and benchmarks

```sh
npm test
npm run benchmark -- 1000
BENCH_MODE=restored npm run benchmark -- 1000
npm run benchmark:ranges
```

Correctness tests and Node.js benchmarks live under `test/`. See [benchmark instructions](test/benchmarks/README.md), [baseline reports](test/benchmarks/providers/cocreatedb/results/README.md) and [provider references](test/benchmarks/providers/README.md).

### Local benchmark baseline

November 19, 2026; Node 22.16.0, Linux x64, 1,000 objects, five independent runs, 40 measured query samples and 10 warmups. Fresh configuration; median of run metrics.

| Operation | Time |
| --- | ---: |
| Create and index 1,000 | 75.378 ms |
| UUID read p50 | 0.0045 ms |
| Equality read p50 | 0.1102 ms |
| Nested read p50 | 0.1275 ms |
| Range read p50 | 0.2118 ms |
| Update p50 | 0.0318 ms |
| Delete 25 | 0.7866 ms |

These historical measurements were in-process and memory-only, excluding network, workflow and durable storage costs. Historical MongoDB and Redis references are retained separately; they are not controlled equivalent-workload comparisons. No cross-provider performance claim is made.

## Specifications

See the [specifications index](specifications/README.md) for detailed engine contracts, integration designs and outstanding requirements.

## Source structure

```text
src/
├── index.js          Public DB.init and Tree exports
├── runtime.js        Server composition, organization selection and node memory policy
├── organization.js   Primary-owned roots, addressing and worker ownership
├── trees.js          Execution-local Trees and worker-local pruning
├── disk.js           Logical file layout
└── tree/
    ├── index.js      One primary's standalone Tree and resource ports
    ├── manager.js    Own leaves, queue, index maintenance and hydration
    ├── execute.js    Stateless CRUD processing
    ├── planner.js    Stateless query planning
    ├── query.js      Index algebra, ordering and selection
    ├── leaf.js       Living leaves and index entries
    ├── btree.js      Index branches
    ├── leaves.js     Own leaf cache and writes
    └── local-core.js Index-node storage
```

## Current limitations

Broader data-type support, atomic batches, production authorization, distributed storage coordination and external workflow integration require further development. Document-dependent predicates and container sorting can require payload evaluation; covered queries use indexes before page hydration. Root constraints are not a substitute for authorization. Disk initialization and directory selection belong to the provider; DB attaches only an initialized Disk resource. Warm-disk acknowledgement is local durability only; Cool Persistence and Cold archive require external integration. Detached persistence requires external error handling, ordering and shutdown policies.

## CoCreateJS

CoCreateDB is part of [CoCreateJS](https://github.com/CoCreateJS), the JavaScript project spanning CoCreate Client and CoCreate Server. Independently usable primitives and configurable workflows allow applications to compose the capabilities they need.

Developed by CoCreate LLC. Licensed under AGPL-3.0 (see repository license).

See the [technical whitepaper](whitepaper.md) for the broader architectural vision.

See [Transactions vs. Synchronization](transactions-vs-synchronization.md) for the rationale behind selective, workflow-based coordination.

### Indexed filtering and sorting

Filters retain the CoCreate Filter/IndexedDB shape: `query`, ordered
`sort: [{ key, direction }]`, `index` (or `startingIndex`), and `limit`.
`limit: 0` is unbounded. Responses report `filter.startingIndex` and the next
`filter.index`. Covered predicates select UUIDs from indexes, order the matches,
and hydrate the requested page. Document-dependent predicates and container
sorting use shared Utils as a fallback. Reads restore only required index paths
and payloads and do not schedule indexing. Active operations protect their
primary Trees from pruning until completion.
