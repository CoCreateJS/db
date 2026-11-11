# CoCreateDB — Next Development Task

> Repository: `CoCreateJS/db`
> Package: `@cocreate/db`
> Current state: filesystem CRUD, recursive indexes, and primary-coordinated local Distributed Index availability events are implemented as a prototype.

## Objective

Build the next synchronization layer on top of the local Distributed Index: explicit local reconstruction and initial availability synchronization when a Cluster node joins. The previous task's incremental `db.distributed` event handling is implemented; full snapshots and recovery are still out of scope for that implementation.

## Current behavior

- `createDB({ directory, nodeId })` maintains database, array, and object availability references in sibling `distributed/` trees using the existing recursive index engine.
- `@cocreate/cluster` exposes `server.DB`. Worker CRUD writes are routed through the primary; the primary serializes writes and applies local availability events.
- Local availability changes emit `db.distributed`. Incoming events are applied by the parent without worker fan-out or rebroadcast.
- Array/database deletion preserves nested distributed indexes containing peer references.
- Distributed files are local Cluster metadata. CoCreateDB currently has no external file persistence adapter.

## Constraints

- Read `AGENTS.md` and `ARCHITECTURE.md` before changing the index engine.
- Keep entity identity scoped by `databaseId + arrayId + objectId`; document IDs are not globally unique.
- Reuse `createIndex`; do not build another indexing engine or transport.
- Keep local availability writes idempotent and serialized through the primary.
- Remote sync application must not trigger a rebroadcast.
- Do not add pruning policy, remote CRUD, new transports, or storage adapters in this phase.
- Preserve unrelated workspace changes and report unsupported failure/recovery guarantees accurately.

## Suggested work

1. Define a streamed/chunked snapshot format for availability entries without document values.
2. Add explicit local reconstruction from the entity files and normal indexes, without running a recurring background scanner.
3. Define snapshot version/checkpoint handling so incremental events arriving during a snapshot are not lost.
4. Test restart, interrupted sync, duplicate chunks/events, and reconciliation of stale references.
5. Keep external persistence filtering for every `distributed/` subtree when a file adapter is introduced.

## Known limits

Multi-file atomicity, crash recovery, missed-event recovery, initial Cluster synchronization, cross-server document write coordination, and standalone multi-process writers are not solved. The existing primary serialization protects local server workers, not independent servers sharing the same filesystem root.

## Prompt for the next implementation

> Continue CoCreateDB Distributed Index work. Read `AGENTS.md`, `ARCHITECTURE.md`, and `NEXT_TASK.md`; inspect the current implementation first. Implement explicit startup reconstruction and initial Cluster availability synchronization using the existing index and Cluster transport. Preserve scoped entity IDs, primary serialization, and no-rebroadcast behavior. Add focused tests and document consistency limits.
