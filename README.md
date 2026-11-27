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
| Node worker | No independent local store by default | DB routes requests to the primary through the Server `send()` interface |

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

The DB composer uses each request's `organization_id` to select or create an organization Tree. Organization is not a configured root; the Tree carries `tree.organizationId`, and its Disk paths are rooted under that ID. Other roots beginning with `$` resolve their names from request properties, such as `$tenant_id` or `$project_id`. A dynamic root value names the structural leaf; it does not become its UUID.

```js
const database = await DB.init({}, {
    config: {
        roots: { $tenant_id: { $project_id: { object: {} } } }
    }
})
```

Create and upsert can establish missing ancestors; reads do not create them. Structural identities are recorded in the organization's Tree config at `tree.config.leaves`, independently from ordinary object data. Configuration can be transferred to another engine to reuse structural UUIDs:

```js
const config = (await database.organizations.get(context.organization_id)).config
const replica = await DB.init({}, { config })
```

This restores structural configuration, not the ordinary objects of the original database. Configuration snapshots are read through `tree.config`; root definitions use `tree.roots.get(path)` and `tree.roots.execute({ operation: 'set', path, data })`, subject to structural validation. Occupied roots cannot be removed or converted between structural and leaf status. Structural renaming and reparenting are not supported.

## Living leaves and automatic indexing

The engine maintains a UUID-keyed leaf map and grouped index trees internally. Index entries reference their original object rather than storing a second complete copy. Each tree has a root branch and index branches that organize scalar values and support ordered range traversal. Query planning selects an available candidate index and verifies matching objects against the query.

A live leaf internally exposes `getValue`, `setValue`, `getIndex` and `delete` methods through its prototype. Use `tree.execute(payload)` or `db.send(payload)` for supported mutations; direct property assignment bypasses index maintenance. UUID, root and parent are immutable through updates; structural names are also protected.

The index primitives are independently usable from the source modules. Their low-level interfaces are not yet a stable package-level contract. The stateless Tree execution function applies updates through Utils. Ordinary updates mutate live leaves directly; timestamp reconciliation uses cloning only when required by its merge semantics.

## Runtime integration

The public entry is `import DB from '@cocreate/db'` followed by `await DB.init(server, options)`. The returned object exposes only `config`, `organizations`, and `send`. `db.organizations.get(id)` returns the organization's Tree, which owns execution, planning, storage ports, pruning and lifecycle. Attach an initialized Disk resource as `server.disk` or `options.disk`; otherwise the database stays in memory. Initialization can optionally prompt through `@cocreate/config`:

```js
import DB from '@cocreate/db'

// server is the existing CoCreate Server instance.
server.db = await DB.init(server, { prompt: false })
```

In standalone usage no server is required. When given a worker Server, DB composes its `send()` interface into a primary-forwarding path; a custom `forward(request)` adapter can override that transport. The primary DB handles those forwarded requests. The `size` option controls index branch sizing.

Local state defaults to `mode: 'adaptive'` with memory acknowledgement. Disk initialization chooses the base directory; Tree adds each organization's directory. `mode: 'disk-cache'` clears the DB-managed base on startup.

The composer consumes Telemetry's node-wide `memory.max` percentage. At 75% it starts pruning; pruning stays active until usage reaches 50%. It selects the lowest-weight eligible primary branch across the managed organization Trees. A primary branch represents an entire table, potentially containing nested tables. Removal releases its resident index trees, descendant branches and leaves together. Stored files and configuration UUIDs remain available for hydration.

Queued and in-flight indexing protect the entire affected subtree. A group becomes eligible only after leaf writes, index reconciliation, branch/configuration writes and attached Persistence responses have completed. Completing a 1,024-leaf batch does not complete a larger group. Index completion requests another pruning pass while pressure remains active; it does not bypass weight ordering. Pruning does not drain the index queue or wait for busy tables. Memory-only Trees retain their only copy; this implementation requires local Disk for whole-table removal and hydration. Persistence notifications alone do not establish a reloadable local index.

Primary-group weight counts access through that group, including access through nested groups. There is no LRU strategy, terminal-branch ranking, per-stage cleanup or automatic 90% disk-first transition. `tree.prune({ uuid, limit })` uses the same whole-primary-group removal path; UUID selects a primary group and the optional limit counts groups. A standalone Tree's composer decides when to invoke it. Explicit disk-first mode also releases completed groups through this path. Traffic routing, backoff and emergency node protection remain outside DB.
The composer reacts to node memory by requesting Tree cleanup; Tree itself only executes pruning and its storage lifecycle. Traffic routing, backoff, admission and coordination remain responsibilities of the surrounding application.

### Browser storage

The shared package entry works in browser contexts; browser consumers import `@cocreate/db` without selecting a separate entry. Initialize Disk with the desired OPFS directory and attach the resource as `server.disk` or `options.disk`. OPFS is origin-scoped, quota-managed browser storage and requires a secure context. On Node, initialize Disk with the desired filesystem directory and attach the resource through the same composition API.

This is local client-side database storage, not an implicit synchronization channel. A host application connects client and server instances using its CRUD and communication setup; distributed delivery and reconciliation remain external to the DB package.

### Persistence and awareness

Persistence is an optional resource assigned directly to Tree. Tree sends accepted leaf mutations to its `execute(operation)` method; the resource decides whether to write immediately or queue/group work. Workflow integration can be composed outside the DB:

```js
const database = await DB.init(server, {
    persistence: provider
})
const persisted = await database.persist()
```

Tree sends the resource logical operations through `execute(request)`. Leaf and branch write/delete notifications contain their UUID and organization ID after indexing completes; configuration writes carry serialized data. The adapter owns grouping and storage policy. `tree.persist()` delegates to its optional `persist()` method. Without an attached adapter, the default port completes the call without storing data.

```text
CoCreate CRUD → CoCreateDB → CRUD workflow / AST
                              ├─ Persistence
                              ├─ Remote CRUD acquisition
                              └─ Communication
```

For successful `object.create`, `object.update`, and `object.delete` requests in adaptive mode, the response follows the in-memory leaf-map mutation. Create assigns or accepts a UUID and adds the leaf; update changes the resident leaf; delete removes it from the resident map and records its pending disk deletion. A generated-UUID create avoids the supplied-UUID existence lookup. Supplied-UUID create, cold-leaf hydration, and query-based operations may need lookup or matching work before the mutation can be acknowledged.

After the response, Warm local writes proceed asynchronously: leaf writes or deletes first, then deferred in-memory index reconciliation, then branch/index and config writes. A successful memory acknowledgement means the local mutation was accepted; it does not mean this server's leaf or index is already on disk. `flushIndex()` waits for deferred index work, and `flushDisk()` waits for local leaf, branch and config writes. Disk-first request handling waits for its local flush before returning. External Cool Persistence is separate and runs only when explicitly drained or orchestrated by a workflow; it is not part of local-disk completion. Client copies, peer delivery and client-to-server request/response timings belong to the surrounding distributed application, not this local DB API benchmark. The DB returns an `awareness` UUID array with CRUD responses: leaf UUIDs identify returned data, and filtered or mutating operations also identify the resolved parent branch. Socket, IPC and Mesh own recipient awareness and mutation delivery. Cold archive integration is also external.

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
├── index.js       Node server entry
├── browser.js     Browser client entry
├── database.js    Shared asynchronous engine
├── leaf.js        Living leaf and index-entry primitives
├── root.js        Configuration and root resolution
├── node/          Node filesystem adapter and initializer
├── browser/       OPFS adapter and browser initializer
├── crud/
│   └── index.js   CRUD processing
└── tree/
    ├── index.js   Root indexes and index branches
    └── query.js   Query planning and selection
```

## Current limitations

Sorting and search, broader data-type support, atomic batches, stale/concurrent mutation reconciliation, production authorization, complete root-index recovery and external workflow integration require further development. Root constraints are not a substitute for authorization. Disk initialization and directory selection belong to the provider; DB attaches only an initialized Disk resource. Warm-disk acknowledgement is local durability only; Cool Persistence and Cold archive require external integration. Detached persistence requires external error handling, ordering and shutdown policies.

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
primary subtrees from pruning until completion.
