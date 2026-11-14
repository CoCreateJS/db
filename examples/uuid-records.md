# Flat record addressing

The production layout is covered by `test/flat-files.test.js`, `test/flat-indexes.test.js`, and `test/peers.test.js`.

```text
<organization_id>/
  root.json
  indexes/<indexId>.json
  storages/<fileUUID>.json
  databases/<fileUUID>.json
  arrays/<fileUUID>.json
  objects/<fileUUID>.json
  values/<valueId>.json
  deleted/<deletionId>.json
  distribution/...
```

`root.json` contains `{ format: "cocreate-uuid-v1", storages: "<catalogId>" }`.
It and the empty storage catalog remain after deleting all storage records.
Storage, database, and array records contain `index`, pointing to their child
catalog. Catalogs and field indexes use the same recursive splitting engine.
The logical hierarchy lives in those references, not filesystem directories.

Index leaves hold `[fieldValue, fileUUID]`; `_id` is an ordinary indexed value
and remains the public document identity. Different arrays can contain the same
public `_id` with distinct file UUIDs. Duplicate IDs within one array are rejected.
UUIDs remain stable through updates and renames.

In memory, a non-enumerable Symbol associates the UUID with the actual record.
It does not add a field to user documents. Mesh explicitly carries `fileId` and
metadata file IDs because JSON does not serialize Symbols. Peer creates transfer
the record, peer updates transfer `$update`, and client update replies retain the
resolved record plus patch. Disk stores the complete plain JSON record.

The root is exchanged in peer inventory snapshots and root announcements. Files
and terminal-array values are acquired on demand. Acquired data is cached locally
when disk is enabled; `disk: false` keeps local data and inventory in memory.
Peer inventory is never persisted. Transport JSON parsing creates the receiver's
values; DB-owned objects and arrays are otherwise mutated by reference.

Use a fresh test directory. Existing datasets require an explicit migration;
opening an unversioned nonempty data directory fails before initialization writes.
No migration, distributed conflict policy, or multi-file transaction is included.
