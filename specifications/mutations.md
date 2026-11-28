# Mutations

## Current

In adaptive mode, each successful create, update or delete applies its mutation to the resident leaves Map before returning its memory acknowledgement. Generated-UUID create skips existence lookup; a supplied UUID must be checked. Update and delete may first need to hydrate a cold leaf or resolve a query. Those are pre-mutation lookup costs, not post-ack durability work.

After acknowledgement, indexing reconciles the derived indexes and submits serialized file operations to Disk and Persistence independently. Each attached adapter owns its queue and exposes pending/in-flight membership. DB keeps outstanding completion promises for shutdown and harvesting, rather than another disk queue. Adapters handle pending-version coalescing and cancellation. Disk preserves ordering for one file; writes to different files may complete independently. Active operations, indexing and both storage resources protect the owning Tree. No public flush endpoints exist; `tree.close()` waits for outstanding work.

Update applies shared createUpdate to the live leaf, validates identity and values, removes affected index entries, and attaches changed entries. Deferred indexing carries the changed field paths so the Tree reconciles only those entries. A working clone is reserved for stale-date smart merges that need to reconcile incoming and resident values. Direct scalar setValue can move an entry without replacing the leaf. No atomic batch or conflict reconciliation guarantee is made.

```js
{
    method: 'object.update',
    object: [{ uuid: 'uuid8', '$inc.quantity': 5 }],
    updated: [{ uuid: 'uuid8', root: 'object', quantity: 15 }],
    success: true
}
```

The snapshot is abbreviated; actual updated entries contain the complete resulting leaf, including parent and other fields when present. Existing updates preserve request patch operators for communication and return independent structuredClone snapshots. After indexing, Tree sends the same serialized changes independently to both storage resources. The resource owns any queueing and snapshot policy; Tree does not keep a persistence journal. `tree.persist()` delegates to the resource's optional `persist()` method. Upsert creation returns a created leaf, not necessarily an updated snapshot. Deletes identify removed leaves.

## Planned

Transform accepted mutation intent when conflict handling requires it; do not advertise rejected changes as applied. Preserve operation identity and original timestamp, explicitly represent removed keys, and handle relative operators exactly once per recipient. Reduce clone/diff overhead without bypassing validation or index maintenance. See [reconciliation](reconciliation.md).
