# Mutations

## Current

In adaptive mode, each successful create, update or delete applies its mutation to the resident leaves Map before returning its memory acknowledgement. Generated-UUID create skips existence lookup; a supplied UUID must be checked. Update and delete may first need to hydrate a cold leaf or resolve a query. Those are pre-mutation lookup costs, not post-ack durability work.

After acknowledgement, local Warm work is ordered: persist changed/deleted leaves, reconcile the derived in-memory indexes, then persist index branches and config. Leaves are the value source of truth; index completion does not decide whether the leaf mutation was accepted. `flushIndex()` waits for derived index reconciliation. `flushDisk()` waits for local disk writes. Disk-first mode waits for local flushing before returning. External Persistence is a separate, potentially delegated process and is not included in local durability timings.

Update uses shared createUpdate on a cloned object, validates identity and values, removes affected index entries, reconciles object fields in place, then attaches changed entries. It preserves the original leaf object. Direct scalar setValue can move an entry without replacing the leaf. No atomic batch or conflict reconciliation guarantee is made.

```js
{
    method: 'object.update',
    object: [{ uuid: 'uuid8', '$inc.quantity': 5 }],
    updated: [{ uuid: 'uuid8', root: 'object', quantity: 15 }],
    success: true
}
```

The snapshot is abbreviated; actual updated entries contain the complete resulting leaf, including parent and other fields when present. Existing updates preserve request patch operators for communication and return independent structuredClone snapshots. The DB also records changed leaves in `persistence.pending`; an explicit `db.persist()` sends complete current leaf snapshots for upserts and UUIDs for deletes. Upsert creation returns a created leaf, not necessarily an updated snapshot. Deletes identify removed leaves. Persistence of root/index branches is not yet implemented.

## Planned

Transform accepted mutation intent when conflict handling requires it; do not advertise rejected changes as applied. Preserve operation identity and original timestamp, explicitly represent removed keys, and handle relative operators exactly once per recipient. Reduce clone/diff overhead without bypassing validation or index maintenance. See [reconciliation](reconciliation.md).
