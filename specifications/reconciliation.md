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
Durable deletion-order metadata or an equivalent authoritative recovery rule preserves this guarantee after temporary markers are lost.

## Ordering, identity and recovery

Equal-time ordering is deterministic across nodes. Metadata distinguishes independent paths and overlapping parent/child and array changes. Relative operations preserve original intent and identity and have an explicit ordering and replay policy; deduplication prevents a repeated delivery from applying the same effect twice. A timestamp alone does not guarantee convergence under clock skew or noncommutative operations.

Competing creates and recreation require agreement on logical identity and artifact UUID mapping. Deletion-order and deduplication metadata required across restarts belongs in `data/`, under the same workflow as other durable artifacts. Retention must account for delayed replay. Missing bases are acquired or explicitly reported; a relative operation cannot be applied to an invented empty object.

The precise tie-breaker, clock assumptions, per-path metadata, relative-operation ordering and retention horizon are explicit protocol parameters. No convergence guarantee beyond the defined protocol is inferred. See [replication.md](replication.md) and [persistence.md](persistence.md).
