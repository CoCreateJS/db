# CoCreateDB Reconciliation Specification

## Scope

Reconciliation determines which changes are accepted when mutations conflict or
arrive out of order. Mutation application is defined in
[mutations.md](mutations.md); peer delivery and storage are defined in
[replication.md](replication.md) and [persistence.md](persistence.md).

## Core policy: Newer Mutation Wins

- The mutation timestamp is carried in the document's `updated.on` audit
  metadata and retained in the update object used for propagation.
- A newer mutation takes precedence over older conflicting changes, regardless
  of arrival order.
- Mutations are processed sequentially as received, while timestamps determine
  precedence for conflicts.
- Equal timestamps require a stable deterministic tie-breaker, such as mutation
  identity or origin-node identity.
- All nodes use the same policy. Reconciliation does not create a new logical
  mutation or advance the original timestamp.
- No distributed locks or centralized write coordination are required by this
  policy.

## Reconciliation behavior

- Apply newer operations when valid and preserve unrelated document values.
- For older operations, retain newer conflicting values while preserving
  compatible, nonconflicting changes where the operation metadata permits.
- Clone state only when needed to calculate a conditional merge.
- Preserve original mutation timestamps and identities in any reconciled update
  object.
- Do not assume a mutation filtered on one node is universally applicable to
  another node's state.

Document-level `updated.on` alone is insufficient to establish the ordering of
independent field changes. Per-change precedence requires enough metadata to
identify the relevant change. Relative operators such as `$inc` also need stable
operation identities and duplicate protection to avoid applying the same
operation twice.

## Lifecycle conflicts

Create, update, upsert, and delete use the same ordering policy. An update to an
absent document does not create it unless it is an upsert. A delete prevents an
older upsert from restoring the document; only a newer upsert may restore it.
The implementation needs durable deletion-order metadata or an equivalent
authoritative recovery rule if this guarantee must hold after temporary markers
are lost.

## Requirements still needing implementation

- Stable ordering for equal-timestamp mutations.
- Per-field ordering where document-level timestamps are insufficient.
- Idempotency for relative operators and duplicate delivery.
- Deterministic delete-versus-upsert behavior across delayed replication.
- Recovery behavior when persistence or propagation fails.

These are protocol requirements; they do not imply distributed locking.
