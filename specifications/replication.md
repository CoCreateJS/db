# CoCreateDB Replication Specification

## Scope

This specification defines how mutation information moves between peers and
clients. Mutation semantics are defined in [mutations.md](mutations.md),
conflict precedence in [reconciliation.md](reconciliation.md), and storage
lifecycle in [persistence.md](persistence.md).

## Peer propagation

- Peers receive operation-tagged mutation/update objects with the addressing,
  original timestamp and identity, and reconciliation metadata needed to apply
  them.
- Ordinary peer mutations propagate update objects rather than resulting
  document snapshots.
- Receiving peers reconcile incoming operations against their own state before
  applying them.
- Duplicate delivery must not apply relative operations more than once.
- A reconciled update must retain enough original ordering information for
  downstream peers to make the same decision.

## Client propagation

Clients receive the resulting document state together with the corresponding
mutation/update object. Deletions include explicit deletion state.

Return this response as soon as the in-memory CRUD result is ready. Peer
delivery, persistence, and client acknowledgment are not prerequisites. CoCreateDB
does not wait for a client acknowledgment before continuing backend work;
durable client-side recovery is a separate client responsibility and protocol.

## Delivery and responsibility boundaries

CoCreateDB owns peer message shape and mutation application. Mesh owns routing
and delivery mechanics. CRUD Client/Server and CRDT callers may handle their own
offline intent, validation, and pre-submission reconciliation, but CoCreateDB
still applies its specified reconciliation policy to peer mutations.

Message delivery, retries, durable acknowledgments, and multi-file atomicity are
separate guarantees. A successful send alone does not establish durable replica
acknowledgment. Current implementation gaps and alignment work are tracked in
`NEXT_TASK.md`.
