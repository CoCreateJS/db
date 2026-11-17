# CoCreateDB Mutation Specification

## Scope

This specification defines how a single create, update, upsert, or delete
operation changes document state. It does not decide which conflicting
operation is accepted; see [reconciliation.md](reconciliation.md). Peer
delivery is defined in [replication.md](replication.md), and storage lifecycle
in [persistence.md](persistence.md). Public operation flows and method-to-scope
routing are described in [crud.md](crud.md).

## Mutation processing

- Every accepted mutation follows one processing path and produces the resulting
  document state and an operation-tagged update object.
- Reuse an incoming update object when available; otherwise generate one using
  the shared update utility.
- Execute `$set`, `$unset`, `$inc`, and other supported operators against the
  state selected by reconciliation.
- Preserve the mutation's original identity and timestamp. Reconciliation must
  not make an accepted operation appear to be a new user mutation.
- Keep mutation application separate from index maintenance, persistence, and
  peer delivery.

## Document lifecycle

- **Create** creates a document when valid under the selected reconciliation
  result.
- **Update** modifies an existing document. It does not create a missing
  document unless explicitly requested as an upsert.
- **Upsert** creates a missing document or updates an existing one.
- **Delete** removes the document from the active document state when accepted.
- An ordinary update does not recreate a deleted or absent document.

The no-match response for update without upsert, validation failures, and
operator-specific edge cases must be specified by the public CRUD contract.

## Update object semantics

An update object records the operation to apply and its addressing information.
When generated, it must preserve operator intent (for example, an increment is
not rewritten as a set unless the operation contract explicitly requires it).
The object used for peer propagation follows the envelope defined in
[replication.md](replication.md).

## Processing example

For a `$set` operation, reconciliation first determines the accepted field
changes. Mutation processing then applies those changes to the selected current
state and produces the resulting document and update object. Storage and peer
delivery follow their respective specifications.

## State and side effects

The accepted operation is applied exactly once to the selected decoded object. The resulting complete object and operation-tagged update are the authoritative in-memory result. Stable snapshots or revisions protect asynchronous persistence against subsequent mutations; the persistence workflow never reapplies update operators. Index maintenance tracks pending changes so a read immediately following acceptance remains correct. A deletion changes active state and retains the ordering information required by reconciliation. The application path preserves supported value types and never converts them through a lossy JSON clone.
