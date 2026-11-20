# CoCreateDB

**An embeddable JavaScript document database built around living artifacts, automatic indexing and configurable scopes.**

CoCreateDB keeps data and its indexes together in memory. Objects retain their identity as they are queried and updated, while index entries reference the objects directly. The engine provides a common CRUD interface for data and structural artifacts, without requiring a database server, storage provider or network connection.

Use CoCreateDB independently in Node.js or compose it with CoCreate Server, CRUD, Workflow and other CoCreateJS capabilities to build persistent and distributed applications.

> Development status: this README describes the current Next implementation. External persistence, distributed acquisition and production integration are separate work; this is not yet a production release.

## Features

- In-process JavaScript document storage and direct UUID lookup.
- Automatic indexing of scalar values, including nested keys using dot notation.
- Living artifacts and index entries that reference the original object.
- Configurable scope hierarchies with dynamic request-driven scope names.
- Shared create, read, update and delete operations across configured scopes.
- Equality and range queries, filtering and pagination.
- Update operators through `@cocreate/utils`.
- Transferable structural configuration that preserves scope identities.
- Standalone operation and configurable primary/worker forwarding.
- Optional persistence and distributed communication through external capabilities, not dependencies of the engine.

## Getting started

Package: [`@cocreate/db`](https://www.npmjs.com/package/@cocreate/db) · Repository: [CoCreateJS/db](https://github.com/CoCreateJS/db)

For the current development implementation, install dependencies from the checked-out Next branch:

```sh
npm install
npm test
```

The examples below use the development source. Once this implementation is published, use the package import `@cocreate/db` instead.

```js
import db from './src/index.js'

const database = db()
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
    method: 'object.read',
    object: { uuid }
})
```

`send()` returns the CRUD envelope with a `success` flag and an array under the requested scope name. The input may be a single object or an array of objects. Check `success` before using the result; failures include an `error` array.

## CRUD operations

### Read

Read by UUID directly, by a scoped identity, or by a filter:

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

A UUID identifies an artifact directly. Supplied scope constraints are still checked. Filters support dot-notation keys such as `profile.name`. A filter limit of `0` requests all local matches. Results describe the local database, not necessarily the complete contents of an external storage provider or cluster.

### Update

```js
const result = await database.send({
    method: 'object.update',
    object: { uuid, '$inc.quantity': 5, price: 90 }
})
```

The update response preserves the applied patch in `object` and provides complete resulting object snapshots in `updated`. For example, the patch includes `$inc.quantity: 5`, while the corresponding resulting snapshot contains `quantity: 15`. These are two representations of the same mutation, not two mutations. The applied operators are useful for communication; snapshots are useful for whole-object persistence. Snapshots are independent of later mutations. An upsert that creates an artifact returns the created object instead.

### Delete

```js
const result = await database.send({
    method: 'object.delete',
    object: { uuid }
})
```

The response contains the artifacts actually deleted. Structural artifacts with children cannot be deleted until those children are removed.

## Artifacts and scopes

An **artifact** is a data or structural object with a UUID. A **scope** defines its category within a configurable hierarchy. `parent` identifies the immediate parent artifact by UUID; `name` provides a named reference where needed. Scopes are not separate storage engines.

The default configuration is:

```js
{
    version: '1.0.0',
    scopes: {
        $organization_id: {
            storage: {
                database: {
                    array: {
                        object: {},
                        index: {}
                    }
                }
            }
        }
    },
    artifacts: {}
}
```

A scope beginning with `$` resolves its name from the corresponding request property. For example, `$organization_id` resolves `organization_id`. The value names the structural artifact; it does not become its UUID. Other dynamic scope names work the same way.

```js
const database = db({}, {
    config: {
        scopes: { $tenant_id: { $project_id: { object: {} } } }
    }
})
```

Create and upsert can establish missing ancestors; reads do not create them. Structural identities are recorded in `db.config.artifacts`, independently from ordinary object data. Configuration can be transferred to another engine to reuse structural UUIDs:

```js
const config = JSON.parse(JSON.stringify(database.config))
const replica = db({}, { config })
```

This restores structural configuration, not the ordinary objects of the original database. Configuration access uses `getValue(path)` and `setValue(path, value)`; the returned enumerable properties are defensive snapshots. Only scope definitions can currently be edited via `setValue`, subject to structural validation. Occupied scopes cannot be removed or converted between structural and leaf status. Structural renaming and reparenting are not supported.

## Living artifacts and automatic indexing

The engine maintains a UUID-keyed artifact map and grouped index trees internally. Index entries reference their original object rather than storing a second complete copy. Trees organize scalar values into bounded partitions and support ordered range traversal. Query planning selects an available candidate index and verifies matching objects against the query.

An artifact exposes `getValue`, `setValue`, `getIndex` and `delete` methods through its prototype. Use the mutation interface or CRUD operations rather than assigning directly to object properties, which can bypass index maintenance. UUID, scope and parent are immutable through updates; structural names are also protected.

The index primitives are independently usable from the source modules. Their low-level interfaces are not yet a stable package-level contract. Current CRUD updates validate and reconcile a cloned object before modifying its living artifact; update snapshots add another allocation. Further reducing that cost is an optimization target.

## Runtime integration

The public engine exposes `send()` and `config`. It accepts an optional living server object and configuration. The asynchronous initializer integrates with `@cocreate/config`:

```js
import db from './src/index.js'

const server = { isPrimary: true }
server.db = await db.init(server, { prompt: false })
```

In standalone usage no server is required. In worker mode an injected `forward(request)` adapter is required; the engine does not implement IPC itself. The `size` option controls tree partition sizing (default 64).

### Persistence and distribution

CoCreateDB has no persistence hooks, distribution inventories, peer-discovery manager or subscription system. These are composed externally through CRUD and configurable workflows.

```text
CoCreate CRUD → CoCreateDB → CRUD workflow / AST
                              ├─ Persistence
                              ├─ Remote CRUD acquisition
                              └─ Communication
```

The workflow can acknowledge successful local operations immediately and schedule persistence independently, or await durable completion when configured. Missing local data can be acquired from persistence or other servers through standard CRUD requests. Sequential, parallel, recursive and latency-aware acquisition are workflow choices. Socket, IPC and Mesh own recipient awareness and mutation delivery. This architecture permits memory-only operation without making any external capability mandatory.

These integration designs are documented in [persistence](specifications/persistence.md) and [distribution and awareness](specifications/distribution.md). External orchestration, complete acquired-artifact hydration, durable ordering and deduplication are not implemented by this engine checkpoint.

## Tests and benchmarks

```sh
npm test
npm run benchmark -- 1000
BENCH_MODE=restored npm run benchmark -- 1000
npm run benchmark:ranges
```

Correctness tests and Node.js benchmarks live under `test/`. See [benchmark instructions](test/benchmarks/README.md), [baseline report](test/benchmarks/baselines/2026-11-19-final/README.md) and [provider references](test/benchmarks/providers/README.md).

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

These are in-process memory-only measurements, excluding network, workflow and durable storage costs. Historical MongoDB and Redis references are retained separately; they are not controlled equivalent-workload comparisons. No cross-provider performance claim is made.

## Specifications

See the [specifications index](specifications/README.md) for detailed engine contracts, integration designs and outstanding requirements.

## Source structure

```text
src/
├── index.js       Engine factory and initialization
├── artifact.js    Living artifact and index-entry primitives
├── scope.js       Configuration and scope resolution
├── crud/
│   └── index.js   CRUD processing
└── tree/
    ├── index.js   Partitioned index trees
    └── query.js   Query planning and selection
```

## Current limitations

Sorting and search, broader data-type support, atomic batches, stale/concurrent mutation reconciliation, production authorization, full hydration and external workflow integration require further development. Scope constraints are not a substitute for authorization. The current engine is memory-only and process termination loses ordinary data unless an external capability has preserved it. Detached persistence requires external error handling, ordering and shutdown policies.

## CoCreateJS

CoCreateDB is part of [CoCreateJS](https://github.com/CoCreateJS), the JavaScript project spanning CoCreate Client and CoCreate Server. Independently usable primitives and configurable workflows allow applications to compose the capabilities they need.

Developed by CoCreate LLC. Licensed under AGPL-3.0 (see repository license).

See the [technical whitepaper](whitepaper.md) for the broader architectural vision.

See [Transactions vs. Synchronization](transactions-vs-synchronization.md) for the rationale behind selective, workflow-based coordination.
