# CRUD Awareness

Status: implemented routing baseline. CoCreateDB returns awareness references with CRUD responses. Socket, Cluster IPC and Mesh maintain recipient maps and route mutations.

## CRUD reference contract

Every CRUD response includes an `awareness` array of UUID strings. The DB builds this array while resolving results:

- Direct UUID reads include the returned leaf UUID.
- Filtered reads include the resolved parent UUID and every returned leaf UUID, including the parent for an empty result.
- Create, update and delete results include the changed leaf UUIDs and their parent UUIDs.
- Duplicate references are returned once.

The DB returns references only. It does not store recipient registrations or choose network routes.

## Recipient maps

Each communication layer owns a process-local index with the same shape:

```js
Map<organizationId, Map<referenceUUID, Set<recipientId>>>
```

The recipient ID is a client ID in SocketServer, a worker ID in Cluster IPC, and a peer server ID in Mesh. Organization scope prevents references from routing data across tenants.

Successful CRUD responses register the originating client or worker. Mesh registers a peer when it receives an awareness-bearing CRUD message. CRUD mutations use matching references to select recipients. Reads return through their request correlation path rather than being fanned out as mutations.

Recipient entries are removed when their client, worker or peer disconnects. Organization eviction clears that organization's entries. These indexes are runtime routing state and are rebuilt as CRUD traffic establishes awareness.

## Current boundary

This is a routing baseline, not a database replication or remote acquisition protocol. An awareness entry records that a recipient received data associated with a reference; it does not prove that a remote DB applied or persisted a mutation. Remote reads, materialization, consistency, retries and DB-backed recipient lookup require separate contracts.
