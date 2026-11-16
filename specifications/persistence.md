# CoCreateDB Persistence Specification

## Scope

This specification defines the boundary between CoCreateDB's in-memory data
operations and durable storage. Mutation state transitions are defined in
[mutations.md](mutations.md), conflict resolution in
[reconciliation.md](reconciliation.md), client and peer propagation in
[replication.md](replication.md), and CRUD response timing in [crud.md](crud.md).

## Core policy: persistence workflow owns storage

CoCreateDB manages data. The configured persistence workflow manages persistence.
All durable storage operations pass through that workflow. CoCreateDB does not
perform direct filesystem, local-disk, or provider I/O as a separate persistence
path.

Local disk is one possible persistence destination selected and operated by the
workflow. It is not a separate database storage mode or a core-managed file cache.
The same rule applies to cloud object stores, external databases, and other
providers.

## Workflow responsibilities

When a value reaches a persistence cycle, CoCreateDB invokes the configured
persistence workflow with the data or artifact operation. The workflow defines
how, where, and when persistence happens. It may invoke local filesystem, AWS
S3, Google Cloud Storage, Azure Blob Storage, external databases, or other
providers in any configured combination.

The workflow configuration controls whether provider operations run in parallel,
sequentially, or in another defined order. Provider selection, execution order,
concurrency, retries, encryption, and provider-specific behavior belong to the
workflow and its configured operations, not to CoCreateDB's storage core.

All persisted artifacts are subject to this boundary, including document data,
index nodes, root/catalog metadata, and other database-owned artifacts. CoCreateDB
may maintain its in-memory working state for fast reads and writes; that state
does not create an independent file/disk persistence path.

## Response and persistence timing

Persistence is downstream of the CRUD response. Once the requested data is ready
in memory and the operation has produced its result, CoCreateDB returns the
response without waiting for the persistence workflow, peer acknowledgments, or
client acknowledgments.

The CRUD response confirms that the operation was processed in memory. It does
not confirm that any persistence destination completed a durable write. Client
IndexedDB or another client-side store is an independent layer and does not delay
the CoCreateDB response.

Write-behind describes this always-on response-first lifecycle; it is not a
configuration option. Persistence cycles invoke the workflow after the response
boundary. `flush()` and shutdown may request/drain pending workflow work, but do
not alter the per-request response contract or imply crash-atomic multi-artifact
commits.

## Prohibited parallel storage paths

- Do not let CoCreateDB read or write durable files directly outside the
  persistence workflow.
- Do not keep separate `file`, `disk`, or equivalent flags that select or bypass
  a core filesystem persistence path.
- Do not let a local filesystem adapter silently act as fallback when no
  workflow operation is configured.
- Do not make peer or client acknowledgments prerequisites for returning CRUD
  results.

The workflow configuration is the sole authority for persistence destinations
and their execution. The behavior when no persistence workflow is configured
must be explicitly defined; it must not silently restore a direct-disk fallback.

## Deletion and recovery

An accepted deletion is represented in memory and passed through the persistence
workflow as a deletion operation for the relevant artifacts. Deletion ordering
metadata needed to prevent stale mutations from resurrecting a record must also
be persisted through the workflow when required by
[reconciliation.md](reconciliation.md). CoCreateDB must not introduce a separate
on-disk tombstone path outside workflow control.

Retry/replay, multi-artifact transactions, crash recovery, and durable replica
acknowledgments are distinct guarantees. The workflow defines provider actions;
CoCreateDB must document any guarantees the workflow contract itself exposes.

## Current implementation alignment

The current prototype performs local filesystem reads/writes through DB-owned
helpers and supports a write-behind queue, `disk`, `memoryOnly`, and related
options. Server external workflow writes are feature-gated off. These are legacy
implementation paths to align with this specification; they are not the target
architecture. See [`../NEXT_TASK.md`](../NEXT_TASK.md).
