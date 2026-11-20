# CoCreateJS — Distribution and Awareness

Status: architectural decision and integration specification. Distribution is removed from CoCreateDB; the external workflows below are proposed, not implemented by this checkpoint.

## Component ownership

CoCreateDB stores living artifacts, scopes and indexes and processes local CRUD operations. It does not maintain local or remote availability inventories, publish server records, discover peers, subscribe to remote changes or choose network routes. Its existing artifacts and scopes are the local data state, not an additional distribution state.

CoCreate CRUD orchestrates requests through configurable workflows. It selects the database, calls it, resolves missing data through persistence or other CRUD endpoints, materializes acquired data when appropriate, and returns the final response. CoCreate Cluster (IPC and server mesh) and CoCreate Socket own communication and awareness. Persistence is optional and provides durable data access. No dependency on the platform database is required to discover artifact locations.

## Acquisition workflow

1. Authorize the request and resolve its configured scope and database.
2. Execute the local database read. Return immediately if the result is sufficient.
3. If local data is missing or incomplete, execute the configured acquisition workflow.
4. Materialize acquired artifacts locally when configured, preserving UUIDs, scope, parent and values, and establish awareness through the communication request lifecycle.
5. Return the result to the original requester through the original correlation path.

Use standard CRUD requests and responses between servers. Do not introduce a separate inventory exchange protocol. A remote read can be restricted to local data or allowed to forward according to the selected workflow. An acquisition is not a new logical create, and must not generate a new UUID, a repeated activity, or a fresh mutation broadcast.

## Configurable strategies

The following configuration is illustrative, not a committed API. It belongs to CRUD/workflows, not DB.

```js
acquisition: {
    order: ['memory', 'cluster', 'persistence'],
    cluster: {
        strategy: 'recursive',
        sort: 'latency',
        materialize: true
    }
}
```

| Strategy | Behavior |
| --- | --- |
| Standalone | Local memory only |
| Persistence-first | Memory, then configured persistence; optional peer fallback |
| Peer-first | Memory, then peers; optional persistence fallback |
| Sequential | Origin requests peers individually and awaits each result |
| Parallel | Origin requests eligible peers simultaneously; peers do not forward |
| Recursive | Each peer awaits the next peer in an ordered route |
| Batched / hedged | Request subsets or start additional peers after a delay |

Ordering, concurrency, deadlines, materialization, fallback and result aggregation are independent policy choices. Workflows may later be expressed through AST. Persistence can be a nearby regional endpoint or replicated provider; its consistency and locality depend on provider configuration. No persistence is mandatory for in-memory distribution.

## Recursive acquisition

Assume A originates a UUID read and the eligible route is B, C, D. Only D has the artifact.

```text
A -> B -> C -> D
A <- B <- C <- D
```

A awaits B, B awaits C, C awaits D. Each node invokes its local DB first and forwards on a miss. D returns its result. C, B and A unwind their awaits and, if configured, materialize the same artifact locally. Each hop uses ordinary CRUD and can establish its own communication awareness. Intermediate materialization is optional; it is not required for forwarding. If none has data, the last node returns a miss, which unwinds to A, where the workflow can proceed to persistence. Do not repeat persistence at every hop unless explicitly configured.

The origin can compute an ordered route from known, authorized organization peers and measured network latency. Forwarders consume the remaining route; no node is revisited. Alternatively a dynamic route may use an explicit visited set and hop budget. Nearest-first is a policy, not a guarantee of the shortest total path. Bound the request by a deadline and preserve correlation across hops. Distinguish peer errors and timeouts from misses.

## Parallel and sequential acquisition

In parallel mode A sends to B, C and D concurrently with forwarding disabled. For a UUID read, accept the first valid response that meets the consistency policy; an empty response must not win over a later hit. Stop or ignore outstanding work safely, and clean up pending correlations. If all eligible responses are misses, fall back according to configuration. If peers fail, report incomplete coverage rather than claiming global absence.

In sequential mode A directly awaits B, then C, then D until a valid result is found. Unlike recursion, intermediate peers do not need to forward or retain the artifact. Batched and hedged strategies combine these options to balance latency and fanout.

For filtered, range, sorted or paginated reads, local results and first peer results may be incomplete. The workflow needs authoritative coverage or aggregation across eligible sources, deduplication by UUID, conflict resolution, global filtering/sorting/pagination and explicit completeness. Do not mistake a local empty array for global nonexistence. Avoid allocating new structural UUIDs on a read miss. Current DB responses do not yet expose a completeness contract.

## Awareness and distribution

Awareness is knowledge of connected organizations, users/clients, workers, servers and their interest in data. Distribution is the resulting delivery of changes to eligible recipients. Naming remains open; the distinction is behavioral, not a requirement for a new module.

Ordinary CRUD requests and successful acquisitions establish interest in the communication layers using their existing distribution-reference primitives, extended consistently where needed. A server-to-server CRUD read is important because it exposes the requesting server and requested data to mesh, just as worker and client CRUD operations expose their identities to IPC and Socket. Writes can also establish interest when the caller retains data. Track subscriptions against relevant artifact UUIDs and, where needed, scope/query membership for new matching artifacts. Organization presence is a routing boundary, not by itself proof of artifact interest.

| Layer | Owns awareness of | Release condition |
| --- | --- | --- |
| Socket | Connected clients/users and their data interests | Disconnect, unsubscribe or expiry |
| IPC | Workers and their data interests | Worker exit, unsubscribe or last relevant interest |
| Mesh | Connected servers and their data interests | Peer disconnect, organization release or unsubscribe |

Reuse common reference-management semantics where appropriate. Keep each layer's recipient state separate and release references when no longer needed, including when an artifact is evicted. Multiple clients/workers can share an upstream interest; remove upstream interest only after its last dependent reference is released. A forwarded request need not establish a permanent local replica subscription if the intermediate node retains nothing; preserve the downstream route or establish direct interest as appropriate.

A successful acquisition must establish an update path without losing changes between read and subscription; use a version/watermark or equivalent reconciliation. Reconnection must restore active interests and reconcile missed changes. Do not rely on a published server inventory to achieve this.

## Mutation lifecycle

A logical create/update/delete is applied through CRUD to DB and emitted through the normal communication pipeline. Socket, IPC and mesh select interested recipients, subject to scope and authorization. A receiving primary applies the mutation to its materialized artifacts; workers and clients receive their relevant updates. Do not execute a forwarded mutation twice or rebroadcast it as a new originating mutation. Preserve mutation identity, origin and correlation; ordering, deduplication and conflict policies are required, especially for increments and concurrent writes. If a mutation changes query membership, route to affected scope/query interests as well as known artifact holders. Activity records must not recursively create activities.

Route acquisition reads separately from replication writes and acknowledgments. Never retry a failed write blindly against another node: the original might already have committed. Authoritative creation, UUID ownership and concurrent upsert policy require explicit decisions. No availability publication through a platform server object is needed, eliminating that feedback path.

## Persistence and eviction

Persistence is the next DB development focus. It can be used directly by a configured local storage workflow, independently of the network, and should preserve structural UUIDs. Define hydration, write queue, durability, errors and flush behavior. Evicting memory is not deleting durable data. Organization release may allow eviction of its materialized artifacts/scopes after outstanding reads/writes finish, pending durable writes are safe, and awareness references are released. In memory-only mode, eviction of the last copy loses data; define retention or explicit handoff rather than assuming that another node holds it.

## Integration checklist

- DB: remove distribution scaffold; keep storage and indexing independent of transport. Define local miss/completeness and materialization contracts; implement persistence hydration and durability.
- CRUD: implement configurable acquisition workflows, request correlation, route bounds, result aggregation and authorization. Retain standard CRUD envelopes where possible.
- Cluster / IPC / mesh: inspect and extend current reference registration, routing and cleanup; targeted distribution keys must reach interested remote nodes and receiving primaries when appropriate.
- Socket: verify client reference removal, scope/query interest and last-user lifecycle. Do not duplicate awareness in DB.
- Test local hits/misses, recursive hit/all-miss, parallel first valid result, partial failures, timeouts, duplicate mutations, reconnect, subscription races, tenant isolation, shared interests and last-copy eviction.

This document describes architecture, not completed cross-repository functionality. The current prototype still lacks persistence reads/hydration, remote materialization, and local completeness reporting. Existing production communication behavior must be reviewed before implementing these workflows.

## Workflow integration decision

CRUD calls `db.send`, then a configurable CRUD workflow. That workflow orchestrates both remote acquisition and optional persistence (see [persistence.md](persistence.md)). Awareness and mutation delivery remain communication-layer responsibilities. The database does not maintain distribution or persistence hooks.
