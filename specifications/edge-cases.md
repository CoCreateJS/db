# CoCreateDB Edge Cases

This file records problematic situations that cross specification or module
boundaries. It is a problem/solution catalog, not a second source of policy.
Each entry links to the authoritative specification. When an edge case becomes
an implementation task, track the work in `NEXT_TASK.md` and keep this entry
focused on the scenario, impact, resolution, and status.

## Mixed values queried through an ordered index

**Scenario:** One field contains strings, numbers, arrays, nulls, or other mixed
values, and a query uses equality or a relational operator.

**Impact:** JavaScript comparison behavior can coerce values, and relational
comparison is not a total ordering for arbitrary values. A type-specific or
overly narrow index scan could omit matching documents.

**Resolution or candidate:** Preserve supplied values without schema conversion. Apply the
shared query operator to candidates and use broader scans whenever index
boundaries cannot safely exclude a value. Define a deterministic tree ordering
that does not change query results.

**Status:** The behavior principle is specified; the mixed-value total order and
safe pruning limits remain implementation decisions.

**Specification:** [indexes.md](indexes.md)

## Concurrent updates with equal or partial ordering information

**Scenario:** Two nodes update the same document concurrently. Their mutations
have equal timestamps, or document-level `updated.on` does not show which of two
independent field changes is newer.

**Impact:** Nodes may choose different winners or overwrite a compatible change
if tie-breaking or per-field ordering information is insufficient.

**Resolution or candidate:** Use the `updated.on` mutation timestamp, a deterministic tie-break
for equal timestamps, and per-change ordering metadata where document-level time
cannot distinguish fields. Reconcile independently on each receiving node.

**Status:** Newer Mutation Wins is specified; the tie-break representation and
per-field metadata are still to be implemented.

**Specifications:** [reconciliation.md](reconciliation.md),
[replication.md](replication.md)

## Duplicate delivery of a relative update

**Scenario:** A peer receives the same `$inc` or other relative operation more
than once after a retry or reconnect.

**Impact:** Applying the operation twice changes the document incorrectly even
though the original mutation was valid.

**Resolution or candidate:** Carry a stable mutation identity and make application idempotent
for duplicate identities. Preserve operation identity when forwarding a
reconciled update.

**Status:** Required by the target contract; deduplication metadata and retention
rules remain to be implemented.

**Specifications:** [reconciliation.md](reconciliation.md),
[replication.md](replication.md)

## Delete followed by a delayed older upsert

**Scenario:** A delete is accepted, then an older upsert arrives after temporary
in-memory deletion knowledge has expired or after the node restarts.

**Impact:** The old mutation can resurrect a document that should remain deleted.

**Resolution or candidate:** Compare delete and upsert ordering using durable deletion-order
metadata, or another authoritative recovery rule, persisted through the
persistence workflow.

**Status:** The required outcome is specified; durable metadata and recovery
behavior remain open implementation work.

**Specifications:** [reconciliation.md](reconciliation.md),
[persistence.md](persistence.md)

## Process failure after the immediate client response

**Scenario:** CRUD returns the in-memory result before the persistence workflow
or peers finish, and the process fails before those background effects complete.

**Impact:** The client may have the result while the database's durable store or
other nodes do not. If the response was not delivered or the client did not
persist it locally, that copy may be unavailable too.

**Resolution or candidate:** Keep the response-first boundary and dispatch peer updates
immediately alongside it. The client may retain its response in IndexedDB or
another local store. Use workflow-managed persistence and a defined replay or
recovery path for unfinished database work; do not delay the response waiting
for acknowledgments.

**Status:** Response priority is specified. Durable workflow replay, client
recovery, and guarantees when delivery itself fails remain separate open work.

**Specifications:** [crud.md](crud.md), [replication.md](replication.md),
[persistence.md](persistence.md)

## Persistence workflow has partial provider failure

**Scenario:** A workflow writes an artifact to multiple configured destinations
and only some operations succeed, or the workflow itself is unavailable.

**Impact:** Copies may diverge, and the CRUD response has already been returned
without waiting for persistence.

**Resolution or candidate:** Let workflow configuration define provider order, parallelism,
retry, and compensation behavior. CoCreateDB reports workflow execution status
separately from the completed CRUD response and must not silently fall back to
direct disk I/O.

**Status:** Workflow ownership is specified; invocation results, missing-workflow
behavior, and partial-failure reporting need implementation contracts.

**Specification:** [persistence.md](persistence.md)

## Encryption and key rotation across stored artifacts

**Scenario:** Encryption is enabled while objects, indexes, root metadata, or
distribution artifacts are being persisted, and the encryption key rotates
while some nodes or artifacts still use an earlier key.

**Impact:** Data may become unreadable, indexing may expose sensitive values, or
stale nodes may fail to decrypt artifacts during propagation and recovery.

**Resolution or candidate:** Perform encryption and key selection in the persistence
workflow, covering every artifact type that may contain sensitive information.
Use a versioned key reference and a staged rotation/re-encryption procedure;
keep decryption capability for prior key versions until migration completes.

**Status:** The persistence workflow owns encryption configuration, but artifact
coverage, key references, rotation, and secret-handler integration still need a
dedicated security specification.

**Specification:** [persistence.md](persistence.md)
