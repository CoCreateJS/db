# CoCreateDB

## A Storage-Independent Architecture for Secure, Portable and Distributed Data

**Technical whitepaper — living document**

## Abstract

CoCreateDB is a JavaScript-native database engine built around living artifacts, stable UUID identity and independently usable indexing primitives. It separates logical structure and in-memory execution from physical persistence, network distribution, security and ownership.

Rather than requiring every deployment to adopt a fixed storage engine or replication topology, CoCreateDB enables applications to compose these capabilities through external workflows. A local engine can operate independently; a distributed application can use the same CRUD interface while acquiring, persisting and synchronizing data through authorized infrastructure.

This architecture aims to reduce duplicated traversal, memory residency and application orchestration while allowing data to remain portable across providers and compute environments. The current engine implements local memory operations and runtime indexing. Durable persistence, distributed acquisition, reconciliation and cryptographic policies are integration designs or research directions, not claims of completed functionality or certification.

**Your data is not trapped inside a database. Your data is the database.**

## 1. Architectural philosophy

A database should be defined by its logical relationships rather than the location of its bytes. CoCreateDB separates five responsibilities: logical structure, indexing, durable persistence, communication, and security. The engine owns the first two. The remaining responsibilities can be composed independently without introducing provider-specific behavior into the engine.

This separation permits an embedded application, a primary/worker runtime and a geographically distributed application to share the same data model. It does not eliminate the cost of persistence or consistency; it makes those policies explicit and independently selectable.

## 2. Living artifacts and universal identity

An artifact is a live JavaScript object addressed by an immutable UUID. The engine maintains a UUID-keyed Map. Index entries reference the original artifact directly rather than storing a second serialized copy or repeatedly resolving an address through the Map.

Application identity remains distinct from artifact identity. `_id`, `name`, or another application key can be indexed without replacing the UUID. A UUID is an address, not a credential, content hash or storage location. Creation must reject unrelated identity collisions.

UUIDv7, standardized in [RFC 9562](https://www.rfc-editor.org/rfc/rfc9562.html#section-5.7), supplies time-ordered identifiers with a 48-bit millisecond timestamp and remaining version, variant and randomness/monotonicity fields. It is useful for ordering by encoded generation time, not a guarantee of global event ordering or conflict precedence. Generation and collision handling follow the shared utility contract; existing UUIDs must remain stable.

A resident UUID resolves through an expected constant-time Map lookup, subject to request validation and any supplied scope constraints. Nonresident data must be acquired externally. Authorization must precede both paths.

## 3. Configurable logical structure

Scopes define artifact categories, not physical directories. A default hierarchy is `$organization_id → storage → database → array → object/index`. The hierarchy is configurable; any `$`-prefixed scope obtains its name from the corresponding request property. No particular tenant model is hardcoded into the engine.

Each structural artifact records its scope, name and immediate parent UUID. Configuration preserves these structural identities:

```js
{
    version: '1.0.0',
    scopes: {
        $organization_id: {
            storage: { database: { array: { object: {}, index: {} } } }
        }
    },
    artifacts: {
        uuid1: { scope: '$organization_id', name: 'organization-a' },
        uuid2: { scope: 'storage', parent: 'uuid1', name: 'production' }
    }
}
```

The UUID strings above are illustrative. Configuration transfer restores structural identities without a mandatory root index pointer or filesystem manifest. It is not a complete data backup. Consistent provisioning across nodes requires coordination when multiple nodes can independently create the same named structure. Full hydration remains an integration requirement.

## 4. Independent indexing

Indexing is a first-class primitive that can be used independently of higher-level CRUD and network behavior. Indexed keys are represented as flat paths; nested scalar fields use the same index access mechanism as top-level keys. The current implementation uses a type-specific tree per indexed key. A unified mixed-type tree remains an optimization/research direction.

Runtime trees consist of ordered partitions with value boundaries and counts. Leaves group equal values and their live entries; branches group child partitions. Inserts split oversized partitions and removals prune empty partitions. Entries reference their owning objects and partitions, allowing maintenance without a separate durable segment lookup.

**Runtime index partitions are not UUID-addressed persistent artifacts.** They are derived structures rebuilt from resident data. An explicitly modeled index-scope artifact is distinct from these internal partitions.

### Query routing

The engine uses compatible equality and range indexes, favors a smaller available candidate population and verifies candidates against actual object values. Boundaries can eliminate irrelevant partitions. Direct UUID requests bypass ordinary indexes. Nested keys do not require an equivalent depth of index traversal. Current planner behavior and limitations are described in [indexes](specifications/indexes.md).

Richer sorting, search, compound planning, mixed-type semantics and complete nested-array handling require further development. Partial local indexes cannot establish global query completeness.

## 5. Application value model

A complete application object occupies one artifact. Keys participate in indexing without becoming separate durable objects. Applications can explicitly model independent referenced content when separate retention or acquisition is useful.

```js
{
    name: 'vacation.mp4',
    path: '/videos/vacation.mp4',
    content: videoBytes,
    headers: { 'Content-Type': 'video/mp4' }
}
```

The target architecture preserves supported JavaScript values and binary content through compatible serialization without inferring types from filenames or executing stored code. CoSON is a potential shared encoding boundary for external persistence and communication. Codec support does not establish engine support for every value type; round-trip and indexing conformance must be tested independently. Large-object streaming and partial retrieval remain research topics.

## 6. Unified operation lifecycle

The public operation interface is `db.send(request)`. A method such as `object.read` or `object.update` selects the configured scope and operation. Requests carry addressing, predicates and mutation instructions. Responses preserve the logical envelope and contain success or error information and the target scope result.

Updates return applied changes and, for existing targets, resulting snapshots under `updated`. Persistence can consume the complete resulting object while communication uses the accepted operation. Create returns created objects; delete returns removed objects. See [CRUD](specifications/crud.md) for exact current semantics and exceptions.

A proposed integration at the CRUD boundary is:

```js
let response = await server.db.send(data)
response = await server.workflow.send({ name: 'crud', data, response })
return response
```

This illustrates composition, not a built-in database callback or a finalized workflow API. The engine does not invoke persistence or distribution itself. Workflow/AST determines subsequent actions. Across processes the logical envelope survives, not JavaScript reference identity.

## 7. Persistence and portability

The current engine is memory-only. External workflows can persist complete objects and configuration to local filesystems, cloud object storage, databases, network storage or other compatible destinations. UUID identity is independent of filename, directory layout, provider or encoding. No provider-specific paths are mandated.

A workflow can await durable completion or acknowledge an in-memory result and schedule persistence separately. Detached writes require stable snapshots, ordering, retry policy, backpressure, failure visibility and shutdown recovery. Late writes must not overwrite newer state. Reads need not trigger durable writes merely because they have been served.

Portable exports require configuration, complete objects, necessary reconciliation metadata and a compatible codec. Moving durable bytes between providers does not itself ensure a consistent snapshot. Restoration must reconstruct the working set and runtime indexes while preserving UUIDs. See [persistence](specifications/persistence.md).

## 8. Security, encryption and key ownership

Storage independence creates opportunities to separate data custody from encryption-key custody. External integrations can serialize and encrypt objects before writing them, allowing authorized infrastructure to store or deliver ciphertext without decryption privileges. Authenticated encryption, nonce management, key rotation, revocation and recovery require explicit policies and reviewed implementations.

Granular protection may use object-specific keys or grouped security boundaries. A key-management service can enforce independent access rules. Portable keys must be transferred through authenticated, protected mechanisms; portability does not imply unrestricted export of secrets. Indexes, metadata, traffic patterns and identifiers may leak information even when persisted object contents are encrypted.

NIST-aligned control mapping, encrypted querying, hardware-backed key management and multi-party recovery are research and deployment objectives, not certification or engine features. Authorization belongs before database access; dynamic scopes and UUIDs are not security boundaries on their own.

## 9. Demand-driven distribution and acquisition

Distributed deployment does not require the database engine to maintain peer inventories or advertise object locations. CRUD workflows choose sources using ordinary acquisition requests. IPC, Socket and Mesh own connection awareness, delivery and subscription lifecycle.

Possible acquisition policies include local memory only, memory followed by persistence, memory followed by peers, persistence-first or peer-first after a local miss, and combinations of available sources. Selection can be sequential, parallel or recursive. Recursive routes must be bounded and prevent cycles; parallel requests need cancellation or safe late-response handling. First valid object responses can satisfy specific UUID lookups, but range and filter queries may require combining results or proving coverage.

An acquired artifact can be materialized locally without generating a second logical create. Intermediate peers may optionally retain results and establish interest. Full hydration and remote execution ownership remain integration requirements. See [distribution](specifications/distribution.md).

## 10. Distributed memory and ephemeral compute

Memory-first execution allows the same live artifact to serve queries and application state without a separate application cache for every indexed value. In a primary/worker deployment the primary can own the artifact set while workers execute application computation and forward requests. A standalone instance can operate without IPC. Separate processes do not share ordinary JavaScript object references; transport introduces serialization, copies and latency.

Ephemeral nodes may eventually acquire their required working datasets from peers or durable sources without owning the entire database. Safe eviction must distinguish temporary working copies from required durable copies. A local miss is not evidence of global absence, and an interrupted acquisition is not a deletion.

## 11. Subscription-driven synchronization and reconciliation

Communication layers can track interest established by normal CRUD activity and connection lifecycle. Distribution delivers changes to interested recipients; awareness determines who those recipients are. The database does not maintain a separate subscription inventory.

The same logical CRUD operation can reach clients and peer nodes. A receiving node must prevent duplicate effects and re-origination loops. Relative operators such as `$inc` require stable mutation identity and deduplication. Parallel acquisition may race reads, but must not race independent applications of the same mutation without an execution-ownership protocol.

Eventual consistency is a possible external deployment policy, not a guarantee of the current engine. Field-level conflict precedence, deterministic tie-breaking, deletion history and stale operation handling remain to be implemented and validated. Security-sensitive operations may require authoritative coordination or stronger consistency. See [reconciliation](specifications/reconciliation.md) and [replication](specifications/replication.md).

## 12. Detachable data, recovery and storage tiering

Stable artifact addresses allow an integration to move complete objects across physical locations without changing references. Cold data may be archived; frequently accessed data may remain in memory or nearby durable storage. Compute can be provisioned independently of storage ownership.

Reconnection of an unavailable object may restore an application relationship if identity, authorization and version are compatible. This is an architectural possibility, not automatic self-healing. Recovery must distinguish missing, deleted, stale and inaccessible artifacts. Backups must preserve structural identities and all data required by their recovery objective; index partitions can be rebuilt.

Tiering and archival policies must not discard the last required durable copy. Retention, jurisdiction, deletion, reference verification, garbage collection and key recovery are external lifecycle responsibilities.

## 13. Adaptive placement and CDN-assisted delivery

Access frequency, mutation frequency, geographical latency and data-residency restrictions can guide external placement policy. Stable content may benefit from edge caches and content delivery networks. Volatile or security-sensitive values may require origin revalidation or cache bypass.

A mutable UUID alone is not a safe immutable CDN cache key. Version-specific addressing, expiration, invalidation and authorization-aware cache isolation are required as appropriate. Encrypted content delivery does not grant the CDN decryption rights. CDNs are potential delivery sources, not authoritative query engines or write coordinators. This is a research direction.

## 14. Performance and infrastructure economics

Living references, direct UUID resolution and selective index traversal aim to reduce allocations, redundant lookups and repeated data movement. Centralized primary state may reduce duplicate caches across workers. Whether memory consolidation saves money depends on primary bottlenecks, IPC cost, actual cache overlap, garbage collection, failure tolerance and fleet sizing.

The November 19, 2026 local benchmark uses 1,000 objects, Node 22.16.0, five independent runs, 40 samples and 10 warmups. Fresh configuration medians include 75.378 ms create-and-index, 0.0045 ms UUID read p50, 0.1102 ms equality read p50, 0.1275 ms nested read p50, 0.2118 ms range read p50 and 0.0318 ms update p50. These are in-process memory-only measurements, not network-inclusive or durable operation timings. See [raw baseline references](test/benchmarks/baselines/2026-11-19-final/README.md).

End-to-end evaluation must include acquisition, index maintenance, persistence, synchronization, authorization, serialization, network latency and recovery. Comparing to MongoDB or Redis requires equivalent workloads, indexing coverage, deployment boundaries, durability and consistency guarantees. Historical provider references are retained in [benchmarks](test/benchmarks/providers/README.md) but do not establish superiority.

## 15. Applications and data sovereignty

Potential applications include embedded software, multi-worker servers, distributed websites, hybrid cloud systems, personal data stores, archival systems, media delivery and temporary compute environments. Independent persistence and security policies may allow organizations to retain custody of their data and keys while changing infrastructure providers.

Data sovereignty requires more than portable UUIDs: access control, legal jurisdiction, provider contracts, backup retention, data deletion and key custody must be enforced across the complete deployment. Highly sensitive or classified workloads require independent security assessment and appropriate authorization; this architecture alone does not establish suitability.

## 16. Integrity, reliability and future research

Current limitations include complete hydration, sorting/search, richer value-type and nested-array semantics, atomic batches, concurrency and conflict handling, and external workflow integration. Update processing still clones and reconciles state; reducing traversal and allocation is an optimization target.

Further work includes durable ordering, consistent snapshots, distributed deduplication, failure recovery, bounded acquisition, latency-aware routing, subscription cleanup, cryptographic control mapping, encrypted retrieval, large-content streaming and resource-aware placement. Evaluation should measure cold and warm operations, tail latency, throughput, memory per worker and node, failure scenarios and cost per equivalent workload.

The [specifications](specifications/README.md) define current contracts and outstanding requirements. This whitepaper explains their architectural motivation, not an alternative normative API.

## Conclusion

CoCreateDB separates the database's logical structure from the infrastructure that persists, transports and protects it. Living artifacts and independent runtime indexing provide the foundation; external workflows enable deployments to choose how data is acquired, retained, synchronized and secured.

The objective is to make data available where it is needed without coupling its identity to a particular physical location or requiring every application to adopt the same distributed architecture.

**Data should live where it is needed, when it is needed, for as long as it is needed.**

*Store it anywhere. Distribute it where authorized. Query it through one logical interface.*
