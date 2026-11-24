# CoCreateDB — Persistence through CRUD workflows

## Current persistence callback contract

The DB exposes an in-memory pending journal grouped by top-level root UUID at `db.persistence.pending`. Each group maps a changed UUID to `{ op, error? }`. In a server runtime, `db.persistence.send` invokes `workflow.db.persist`; callers can replace that function with a custom transport and trigger a drain explicitly:

```js
db.persistence.send = async envelope => provider.send(envelope)
const result = await db.persist()
```

`db.persistence.send(envelope)` forwards an individual persistence request to the server workflow or replacement callback. The persistence envelope uses `method` and `persistence`; values are UUID-bearing objects:

```js
{ method: 'persistence.upsert', persistence: { uuid: '...', ... } }
{ method: 'persistence.delete', persistence: { uuid: '...' } }
{ method: 'persistence.read', persistence: { uuid: '...' } }
```

The current drain sends pending leaf upserts as complete object snapshots and pending deletes by UUID. A provider response is an acknowledgement when it is non-null and has no `error`, `data.error`, or `success: false`. A successful acknowledgement removes only the exact journal entry that was sent. An error or missing acknowledgement retains the entry and records its error; a newer mutation replaces the old entry and is not cleared by an older in-flight response. Entries are processed sequentially within their root group. If no workflow-backed or custom `send` function is available, `db.persist()` reports `skipped` and leaves the journal untouched.

This is the first transport and journal stage. It does not yet hydrate or update a separate Persistence Tree, or send root/index branch changes. Consequently it is not yet a complete durable representation of CoCreateDB and does not enable `acknowledgement: 'persistence'`.

## Decision

CoCreateDB owns living leaves, roots, indexes, local CRUD and its Hot/Warm residency lifecycle. Hot is memory; Warm is the DB-managed local-disk tier used for write-through, recovery and eviction. This is separate from Cool external Persistence and Cold archival storage, which remain outside the DB engine. The new callback is a transport seam only; complete persistence-tree handling and remote routing are not yet implemented. CoCreate CRUD can orchestrate external Persistence through configurable workflows and AST. Socket, IPC and Mesh own communication awareness and recipient selection. See [architecture](architecture.md), [indexes](indexes.md) and [awareness](awareness.md).

## Entry point

The server-side default sender invokes the named workflow with its configured organization and host:

```js
await server.workflow.run({
    method: 'workflow.db.persist',
    organization_id: server.organization_id,
    host: server.host,
    data: envelope
})
```

The seeded `db.persist` workflow calls the configured AWS API for S3 leaf upserts and deletes. Its region, bucket and prefix are workflow settings; AWS credentials are configured on the `aws` API record. Replacing `db.persistence.send` bypasses this default workflow route. The workflow can later orchestrate multiple provider targets without changing the DB journal envelope.

## Successful local operations

- Create: queue and upsert the complete created leaf, retaining UUID, root and parent. The structural root catalog (`db.config.leaves`) is separately available for configuration persistence; implicit ancestor creation must not be lost.
- Read: do not write to persistence merely because a leaf was read.
- Update: preserve the applied operators for clients and peers, but persistence upserts the complete current UUID-bearing leaf. Do not replay relative operators such as `$inc` against a stored copy.
- Delete: send the confirmed deleted UUID to the provider; retain tombstone/version information externally if required by the deployment.

### Update response in this checkpoint

```js
{
    method: 'object.update',
    object: [{ uuid: 'a', _id: 'id', '$inc.quantity': 5 }],
    updated: [{ uuid: 'a', _id: 'id', root: 'object', parent: 'p', quantity: 15 }],
    success: true
}
```

`object` (or the requested root key) contains the accepted patch with identity; `updated` contains complete independent post-update snapshots in the same order. The field name `updated` is a provisional envelope convention, not a separately emitted event. Preserve operators for client and remote mutation processing. The pending persistence drain obtains the complete live leaf by UUID and sends that snapshot as an upsert; it does not replay `$update`. Do not apply both the envelope `$update` and the returned merged patch a second time. The present engine does not transform stale updates or resolve conflicts; accepted patches are not a CRDT protocol. Snapshots require an extra clone; later optimize without sacrificing correctness. Upsert creation retains the existing full-object response shape; general operator-based upsert semantics remain pending. Reserve `updated` at the integration envelope level or choose an unambiguous metadata location before supporting a field with that name.

Create and delete currently return living references; snapshot/serialize before detached work if the exact committed revision is required. Multi-object operations are not atomic: an error may follow successful earlier mutations. Handle partial outcomes explicitly before production integration.

## Workflow execution

The default local acknowledgement is `memory`: return when the in-memory operation is complete, while local Warm writes continue independently. `disk` acknowledgement waits for affected local writes. These options are instance-level today; memory acknowledgement is not a transaction or a local-durability guarantee. The callback drain is explicit and currently handles pending leaves only; `acknowledgement: 'persistence'` remains unavailable until the Persistence Tree and root/index branch writes are implemented.

A successful local result can immediately acknowledge the in-memory operation while pending leaf persistence remains queued. The host or workflow explicitly calls `db.persist()`; its provider callback receives stable snapshots. Failures remain pending with an error for retry. An immediate acknowledgement is not a durability guarantee. Distinguish in-memory success, queued persistence and durable confirmation. Coalesce whole-object writes where appropriate, order by leaf identity/version, and prevent older writes or delayed creates from overwriting newer states or tombstones. Retry idempotently; designate a persistence writer or deduplicate replicated operations.

## Acquisition and routing

When local data is absent, the CRUD workflow may await persistence, another server, a sequential or recursive chain, parallel requests, or a configured combination. A recursive request consumes an ordered route and returns through outstanding awaits. Parallel probes cannot independently recurse unless the workflow explicitly allows it. Include deadlines and correlate requests. A miss, timeout, invalid request and authoritative absence are distinct. Filtered results may be incomplete, and first-response selection is appropriate only where a single valid result is sufficient.

For read, acquire and materialize the leaf using its existing identity and root, then respond. For missing update/delete, either acquire then perform the mutation once locally, or route the original mutation to an authoritative execution node and reconcile the confirmed result locally; do not blindly execute non-idempotent mutations on every candidate. Use read probes for parallel discovery followed by a single mutation executor. Replication uses normal communication awareness, not persistence-specific broadcasts. Hydration is not a new logical create and must not trigger persistence creation or activity events. Production materialization, completeness tracking and mutation deduplication are not implemented by this checkpoint.

## Boundaries and status

The callback contract and leaf pending-journal drain are implemented. External workflows, adapters, remote acquisition and hydration from Cool/Cold tiers, cluster subscriptions, conflict resolution and complete external durable acknowledgement are still integration work, not implemented by this local prototype. Warm local writes and local disk acknowledgement are implemented by the DB. The current update implementation still clones/reconciles fields and snapshots the result; a later live operator path is an optimization opportunity. Existing local config/bootstrap and worker-forwarding contracts are retained.
