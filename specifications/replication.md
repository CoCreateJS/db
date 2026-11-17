# CoCreateDB Replication Specification

## Scope

Replication propagates mutation intent to peers and resulting state to clients. [Mutations](mutations.md) owns application; [reconciliation](reconciliation.md) owns precedence; [distribution](distribution.md) owns artifact acquisition.

## Client propagation

Clients receive the resulting object and corresponding `$update` for accepted mutations, with explicit deletion state for deletes. Reads return state without a mutation update. The client response is initiated immediately when required acquisition and in-memory result construction finish; neither disk, cloud, peer nor client acknowledgment gates it. Client-side IndexedDB durability is independent.

## Peer propagation

Initiate peer dispatch back-to-back with client response handoff, prioritizing the client without waiting for either acknowledgment. Peer mutations carry operation tags, original timestamp and identity, authorized organization and scope addressing, UUID mapping as needed, and required reconciliation metadata. They carry update intent rather than redundant resulting object snapshots. Create intent includes sufficient initial values; deletion explicitly identifies the lifecycle operation.

Receiving nodes reconcile against their own state, preserve original identity and timestamps, and prevent duplicate effects and re-origination loops. An update filtered at one node is not necessarily appropriate at another. Missing bases are resolved through complete-artifact acquisition or explicit failure; mutation messages and artifact acquisition are distinct protocols.

## Delivery boundaries

CoCreateDB owns mutation message semantics; Mesh owns routing and delivery mechanics. Shared transport encoding preserves the agreed value model end to end on supported paths. Unsupported paths cannot silently coerce values. Transport security is independent of encryption at rest. CRUD Client/Server and CRDT callers can perform independent validation or offline intent management without replacing database reconciliation.

Dispatch success does not establish peer application, durable acknowledgment or crash recovery. Delivery retries, revision agreement and durable acknowledgments follow their explicit integration contracts. Full database replication is not required.
