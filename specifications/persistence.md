# CoCreateDB — Persistence through CRUD workflows

## Decision

CoCreateDB owns living leaves, roots, indexes, local CRUD and its Hot/Warm residency lifecycle. Hot is memory; Warm is the DB-managed local-disk tier used for write-through, recovery and eviction. This is separate from Cool external Persistence and Cold archival storage, which remain outside the DB engine. CoCreateDB has no external provider hooks, distribution inventory or remote routing. CoCreate CRUD orchestrates external Persistence through configurable workflows and AST. Socket, IPC and Mesh own communication awareness and recipient selection. See [architecture](architecture.md), [indexes](indexes.md) and [distribution](distribution.md).

## Entry point

Conceptual integration (not an implemented Workflow API contract):

```js
let response = await server.db.send(data)
response = await server.workflow.send({ name: 'crud', data, response })
return response
```

The envelope already identifies the method, root, request and routing context. Use the standard result; do not invent a second mutation event or a parallel distribution protocol. The workflow can invoke other workflows, APIs, persistence adapters and remote CRUD. Configure the behavior without modifying DB or the runtime.

## Successful local operations

- Create: store the complete returned leaf, retaining UUID, root and parent. The structural root catalog (`db.config.leaves`) is separately available for configuration persistence; implicit ancestor creation must not be lost.
- Read: do not write to persistence merely because a leaf was read.
- Update: propagate the applied change with its operators. Use the resulting object for persistence. Whole-object providers can replace a stored leaf; partial-update providers may derive absolute changed values and explicit removals, rather than blindly repeating non-idempotent operators.
- Delete: use the confirmed deleted identities to remove durable objects; retain tombstone/version information externally if required by the deployment.

### Update response in this checkpoint

```js
{
    method: 'object.update',
    object: [{ uuid: 'a', _id: 'id', '$inc.quantity': 5 }],
    updated: [{ uuid: 'a', _id: 'id', root: 'object', parent: 'p', quantity: 15 }],
    success: true
}
```

`object` (or the requested root key) contains the accepted patch with identity; `updated` contains complete independent post-update snapshots in the same order. The field name `updated` is a provisional envelope convention, not a separately emitted event. Preserve operators for client and remote mutation processing. The workflow can omit `updated` from external delivery after capturing it for persistence. Do not apply both the envelope `$update` and the returned merged patch a second time. The present engine does not transform stale updates or resolve conflicts; accepted patches are not a CRDT protocol. Snapshots require an extra clone; later optimize without sacrificing correctness. Upsert creation retains the existing full-object response shape; general operator-based upsert semantics remain pending. Reserve `updated` at the integration envelope level or choose an unambiguous metadata location before supporting a field with that name.

Create and delete currently return living references; snapshot/serialize before detached work if the exact committed revision is required. Multi-object operations are not atomic: an error may follow successful earlier mutations. Handle partial outcomes explicitly before production integration.

## Workflow execution

The default local acknowledgement is `memory`: return when the in-memory operation is complete, while local Warm writes continue independently. `disk` acknowledgement waits for affected local writes. These options are instance-level today; memory acknowledgement is not a transaction or a local-durability guarantee. External persistence acknowledgement is not implemented by the DB.

A successful local result can immediately acknowledge the in-memory operation while dispatching a persistence workflow without awaiting it. Manage detached work through the workflow runtime: capture a stable payload, retain the promise, handle rejection, retry as appropriate, and drain on orderly shutdown. An immediate acknowledgement is not a durability guarantee. A deployment requiring durable acknowledgement awaits its persistence workflow instead. Distinguish in-memory success, queued persistence and durable confirmation. Coalesce whole-object writes where appropriate, order by leaf identity/version, and prevent older writes or delayed creates from overwriting newer states or tombstones. Retry idempotently; designate a persistence writer or deduplicate replicated operations.

## Acquisition and routing

When local data is absent, the CRUD workflow may await persistence, another server, a sequential or recursive chain, parallel requests, or a configured combination. A recursive request consumes an ordered route and returns through outstanding awaits. Parallel probes cannot independently recurse unless the workflow explicitly allows it. Include deadlines and correlate requests. A miss, timeout, invalid request and authoritative absence are distinct. Filtered results may be incomplete, and first-response selection is appropriate only where a single valid result is sufficient.

For read, acquire and materialize the leaf using its existing identity and root, then respond. For missing update/delete, either acquire then perform the mutation once locally, or route the original mutation to an authoritative execution node and reconcile the confirmed result locally; do not blindly execute non-idempotent mutations on every candidate. Use read probes for parallel discovery followed by a single mutation executor. Replication uses normal communication awareness, not persistence-specific broadcasts. Hydration is not a new logical create and must not trigger persistence creation or activity events. Production materialization, completeness tracking and mutation deduplication are not implemented by this checkpoint.

## Boundaries and status

The database has no external provider hooks. External workflows, adapters, remote acquisition and hydration from Cool/Cold tiers, cluster subscriptions, conflict resolution and external durable acknowledgement are integration work, not implemented by this local prototype. Warm local writes and local disk acknowledgement are implemented by the DB. The current update implementation still clones/reconciles fields and snapshots the result; a later live operator path is an optimization opportunity. Existing local config/bootstrap and worker-forwarding contracts are retained.
