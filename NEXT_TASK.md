# CoCreateDB — Remaining Work

Implemented: server-owned CRUD, supplied/generated `$update` patches, resolved
client replies, peer patch application, index CRUD naming, `disk`, separate local
and peer distribution, connection inventory exchange, and accumulated API errors.

## Persistence workflow

- Wire the agreed `persistence` envelope and `persistence.create/read/update/delete`
  operations to the configured workflow. The retained hook still uses `storage`
  and external workflow writes are disabled.
- Add file-level fallback after memory, disk, and known peers. Return parsed file
  values and use the existing acquisition paths; cache locally when disk is enabled.
- Keep response timing and durability explicit. Do not silently require external
  acknowledgment before notifying users; operation ordering is pending discussion.
- Preserve disabled persistence hooks and legacy complete-object recovery until
  their replacement is implemented and removal is explicitly decided.

## Follow-up decisions

- Cross-node operation ordering, conflict resolution, deletion policy, and
  incremental operation deduplication. No distributed LWW/CRDT policy is implemented.
- Client IndexedDB generation/application of `$update` and client acknowledgment.
- Index update semantics beyond the current insertion alias, tier-level index
  addressing, and optional custom definitions/uniqueness.
- Transfer of terminal-array value files; arrays are currently stored whole,
  with legacy chunk encodings readable.
- Batching large inventory exchanges and handling legacy local ownership when
  the server ID had already changed before stable local markers were introduced.
- Worker/client recipient removal and reconstruction after disconnect/restart.
- Multi-file rollback, write-behind failure handling, and crash recovery. Existing
  baseline failures are not evidence of durable transactions.

Known write-behind checks still need separate attention: rollback at
`test/write-behind.test.js:67`, pending sequential persistence at line 92, and
workflow acknowledgment at line 231 while the external hook remains disabled.

The entity-holder directory is currently used for metadata and exact-object
acquisition. Keep it; replacing it with index-trail lookup requires a separate
architecture decision. Inventory exchange does not enumerate document payloads.

## Constraints

Read AGENTS.md and ARCHITECTURE.md before changing the engine. Preserve scoped
identities, complete acquired documents, shared query/update semantics, reference
ownership, and unrelated workspace changes. Use targeted peer reads with timeouts.
Do not persist peer inventories or remove deferred features merely for having
no active callers. Report what was tested and what remains unsupported.
