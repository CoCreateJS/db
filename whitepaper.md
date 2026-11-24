# CoCreateDB

## A Client-Server Database Engine for Distributed Databases

**Technical whitepaper — living document**

## Abstract

CoCreateDB is a JavaScript-native client-server database engine built around living leaves, stable UUID identity and independently usable indexing primitives. It runs as a local database in browser clients and Node servers, separating logical structure and local execution from external persistence, network distribution, security and ownership.

The client and server use the same database contract with runtime-specific local storage: browser clients use OPFS with disk-first processing, while Node servers use the filesystem and adaptive Hot/Warm residency by default. Each runtime can perform its own local CRUD. CoCreate CRUD, Socket, IPC, Mesh and Workflow layers connect instances, route authorized operations and coordinate synchronization or acquisition. These layers can compose the instances into a distributed database without making the DB package itself own network connections or peer discovery.

This architecture aims to reduce duplicated traversal, memory residency and application orchestration while allowing data to remain portable across providers and compute environments. The current engine implements adaptive Hot memory, Warm local-disk storage and runtime indexing, plus an explicit callback and pending-leaf journal for Cool Persistence. Complete external durability, root/index persistence, Cold archival storage, distributed acquisition, reconciliation and cryptographic policies remain integration designs or research directions, not claims of completed functionality or certification.

**Your data is not trapped inside a database. Your data is the database.**

## 1. Architectural philosophy

A database should be defined by its logical relationships rather than the location of its bytes. CoCreateDB separates logical structure, indexing, local residency, external persistence, communication and security. The same engine runs in browser clients and Node servers while using a platform-appropriate storage adapter. The engine owns local CRUD and indexes; a host-supplied callback handles the current leaf-level Cool Persistence seam without provider-specific behavior in the engine.

This separation permits clients, primary servers, workers and geographically distributed nodes to share a data model and CRUD contract. The runtime-specific local database is distinct from the network behavior that connects instances. It does not eliminate the cost of persistence or consistency; it makes those policies explicit and independently selectable.

### Client and server runtimes

The package's `browser` entry selects the client adapter automatically. It stores local state in OPFS under the origin-private `CoCreateDB/` directory by default and processes requests disk-first without retaining the DB's adaptive Hot working set. The Node `main` entry selects the server adapter, stores state under `~/.cocreate/db` by default and uses adaptive Hot/Warm residency. Both adapters keep the same logical configuration, roots, branches and leaves.

A browser client is a database participant with its own local state; it is not merely a view over a server database. A server is another database participant with its own local state. The surrounding CoCreate CRUD and communication stack decides which instance receives a request, who receives changes and how missing data is acquired. The DB package does not automatically connect these runtimes, broadcast changes, discover peers or guarantee distributed consistency. Those behaviors depend on the host's transport, awareness, persistence and reconciliation policies.

## 2. Living leaves and universal identity

An leaf is a live JavaScript object addressed by an immutable UUID. The engine maintains a UUID-keyed Map. Index entries reference the original leaf directly rather than storing a second serialized copy or repeatedly resolving an address through the Map.

Application identity remains distinct from leaf identity. `_id`, `name`, or another application key can be indexed without replacing the UUID. A UUID is an address, not a credential, content hash or storage location. Creation must reject unrelated identity collisions.

UUIDv7, standardized in [RFC 9562](https://www.rfc-editor.org/rfc/rfc9562.html#section-5.7), supplies time-ordered identifiers with a 48-bit millisecond timestamp and remaining version, variant and randomness/monotonicity fields. It is useful for ordering by encoded generation time, not a guarantee of global event ordering or conflict precedence. Generation and collision handling follow the shared utility contract; existing UUIDs must remain stable.

A Hot resident UUID resolves through an expected constant-time Map lookup, subject to request validation and supplied root constraints. If it is not Hot, the DB can hydrate it from Warm local disk; a local miss may then be handled by an external acquisition workflow. Authorization must precede each path.

## 3. Configurable logical structure

Roots define leaf categories, not physical directories. A default hierarchy is `$organization_id → storage → database → array → object/index`. The hierarchy is configurable; any `$`-prefixed root obtains its name from the corresponding request property. No particular tenant model is hardcoded into the engine.

Each structural leaf records its root, name and immediate parent UUID. Configuration preserves these structural identities:

```js
{
    version: '1.0.0',
    roots: {
        $organization_id: {
            storage: { database: { array: { object: {}, index: {} } } }
        }
    },
    leaves: {
        uuid1: { root: '$organization_id', name: 'organization-a' },
        uuid2: { root: 'storage', parent: 'uuid1', name: 'production' }
    }
}
```

The UUID strings above are illustrative. Configuration transfer restores root definitions and structural leaf identities. It is not a complete data backup or a persisted index-branch catalog. Consistent provisioning across nodes requires coordination when multiple nodes can independently create the same named structure. Full hydration remains an integration requirement.

## 4. Independent indexing

Indexing is a first-class primitive that can be used independently of higher-level CRUD and network behavior. Indexed keys are represented as flat paths; nested scalar fields use the same index access mechanism as top-level keys. The current implementation uses a type-specific tree per indexed key. A unified mixed-type tree remains an optimization/research direction.

Runtime trees begin at a root branch and contain child branches with ordered value boundaries and counts. Terminal branches group equal values and reference data leaves. Inserts split oversized branches and removals prune empty branches. Entries reference their owning leaves and branches, avoiding a separate durable segment lookup.

**Index branches are separate from data leaves.** Branches organize references and ranges; leaves hold the complete records. The runtime root/parent branch catalog is not yet restored after restart.

### Query routing

The engine uses compatible equality and range indexes, favors a smaller available candidate population and verifies candidates against actual object values. Boundaries can eliminate irrelevant branches. Direct UUID requests bypass ordinary indexes. Nested keys do not require an equivalent depth of index traversal. Current planner behavior and limitations are described in [indexes](specifications/indexes.md).

Richer sorting, search, compound planning, mixed-type semantics and complete nested-array handling require further development. Partial local indexes cannot establish global query completeness.

## 5. Application value model

A complete application object occupies one leaf. Keys participate in indexing without becoming separate durable objects. Applications can explicitly model independent referenced content when separate retention or acquisition is useful.

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

The public operation interface is `db.send(request)`. A method such as `object.read` or `object.update` selects the configured root and operation. Requests carry addressing, predicates and mutation instructions. Responses preserve the logical envelope and contain success or error information and the target root result.

Updates return applied changes and, for existing targets, resulting snapshots under `updated`. Persistence can consume the complete resulting object while communication uses the accepted operation. Create returns created objects; delete returns removed objects. See [CRUD](specifications/crud.md) for exact current semantics and exceptions.

A proposed integration at the CRUD boundary is:

```js
let response = await server.db.send(data)
response = await server.workflow.send({ name: 'crud', data, response })
return response
```

This illustrates workflow composition, not an automatic persistence policy. The engine has a replaceable persistence sender and pending-leaf journal; the host or workflow chooses when to drain it. Server instances default to `workflow.db.persist`, while a host can replace `db.persistence.send` with a custom callback. The DB does not maintain distribution state or automatically persist each CRUD request. Across processes the logical envelope survives, not JavaScript reference identity.

## 7. Persistence and portability

The current engine uses Hot memory and Warm local disk. Adaptive mode is the default: its requested memory budget defaults to 25% of total system memory, capped by memory available at startup, and its weighted eviction policy moves eligible leaves and branches to Warm storage as pressure rises. This is a soft DB-residency target, not a hard cap on total process memory. `disk-first` remains available as an explicit mitigation mode and is also entered temporarily by adaptive handling at high pressure. `disk-cache` clears the DB-managed local base on startup. The default acknowledgement is `memory`; `disk` acknowledgement waits for affected Warm writes. Neither setting controls server ingress or guarantees transactional atomicity.

Warm local files are part of the DB's own working and recovery path. The current external persistence seam groups pending leaf changes by root UUID and can send complete UUID-bearing leaf snapshots or UUID deletes through a registered callback. The host or workflow controls when it is drained. Root and index-branch persistence, a separate Persistence Tree, and Cold archival storage are not implemented. UUID identity is independent of filename, directory layout, provider or encoding. No provider-specific paths are mandated.

The default memory acknowledgement returns when the local Hot mutation is available while Warm writes continue separately. `db.persist()` explicitly drains pending leaf changes; it retains failed or unacknowledged entries and clears only the matching acknowledged entry. This early contract does not establish complete database durability, and persistence acknowledgement mode remains unavailable until roots and index branches are included. Reads do not create pending writes merely because they have been served.

Portable exports require configuration, complete objects, necessary reconciliation metadata and a compatible codec. Moving durable bytes between providers does not itself ensure a consistent snapshot. Restoration must reconstruct the working set and runtime indexes while preserving UUIDs. See [persistence](specifications/persistence.md).

## 8. Security, encryption and key ownership

Storage independence creates opportunities to separate data custody from encryption-key custody. External integrations can serialize and encrypt objects before writing them, allowing authorized infrastructure to store or deliver ciphertext without decryption privileges. Authenticated encryption, nonce management, key rotation, revocation and recovery require explicit policies and reviewed implementations.

Granular protection may use object-specific keys or grouped security boundaries. A key-management service can enforce independent access rules. Portable keys must be transferred through authenticated, protected mechanisms; portability does not imply unrestricted export of secrets. Indexes, metadata, traffic patterns and identifiers may leak information even when persisted object contents are encrypted.

NIST-aligned control mapping, encrypted querying, hardware-backed key management and multi-party recovery are research and deployment objectives, not certification or engine features. Authorization belongs before database access; dynamic roots and UUIDs are not security boundaries on their own.

## 9. Demand-driven distribution and acquisition

Distributed deployment does not require the database engine to maintain peer inventories or advertise object locations. CRUD workflows choose sources using ordinary acquisition requests. IPC, Socket and Mesh own connection awareness, delivery and subscription lifecycle.

Possible acquisition policies include the local DB's Hot/Warm state, local state followed by Cool Persistence, local state followed by peers, Persistence-first or peer-first after a local miss, and combinations of available sources. Selection can be sequential, parallel or recursive. Recursive routes must be bounded and prevent cycles; parallel requests need cancellation or safe late-response handling. First valid object responses can satisfy specific UUID lookups, but range and filter queries may require combining results or proving coverage.

An acquired leaf can be materialized locally without generating a second logical create. Intermediate peers may optionally retain results and establish interest. Full hydration and remote execution ownership remain integration requirements. See [awareness](specifications/awareness.md).

## 10. Distributed memory and ephemeral compute

Hot execution allows the same live leaf to serve queries and application state without a separate application cache for every indexed value; Warm disk supplies recovery and offload. In a primary/worker deployment the primary can own the leaf set while workers execute application computation and forward requests. A standalone instance can operate without IPC. Separate processes do not share ordinary JavaScript object references; transport introduces serialization, copies and latency.

Ephemeral nodes may eventually acquire their required working datasets from peers or durable sources without owning the entire database. Safe eviction must distinguish temporary working copies from required durable copies. A local miss is not evidence of global absence, and an interrupted acquisition is not a deletion.

## 11. Subscription-driven synchronization and reconciliation

Communication layers can track interest established by normal CRUD activity and connection lifecycle. Distribution delivers changes to interested recipients; awareness determines who those recipients are. The database does not maintain a separate subscription inventory.

The same logical CRUD operation can reach clients and peer nodes. A receiving node must prevent duplicate effects and re-origination loops. Relative operators such as `$inc` require stable mutation identity and deduplication. Parallel acquisition may race reads, but must not race independent applications of the same mutation without an execution-ownership protocol.

Eventual consistency is a possible external deployment policy, not a guarantee of the current engine. Field-level conflict precedence, deterministic tie-breaking, deletion history and stale operation handling remain to be implemented and validated. Security-sensitive operations may require authoritative coordination or stronger consistency. See [reconciliation](specifications/reconciliation.md) and [replication](specifications/replication.md).

## 12. Detachable data, recovery and storage tiering

Stable leaf addresses allow an integration to move complete objects across physical locations without changing references. Frequently accessed data may remain Hot in memory, Warm local-disk state supports recovery and offload, Cool external Persistence supplies provider-backed durability, and Cold storage can hold long-term archives. Compute can be provisioned independently of storage ownership.

Reconnection of an unavailable object may restore an application relationship if identity, authorization and version are compatible. This is an architectural possibility, not automatic self-healing. Recovery must distinguish missing, deleted, stale and inaccessible leaves. Backups must preserve structural identities and all data required by their recovery objective; index branches can be rebuilt.

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

Further work includes durable ordering, consistent snapshots, distributed deduplication, failure recovery, bounded acquisition, latency-aware routing, subscription cleanup, cryptographic control mapping, encrypted retrieval, large-content streaming and resource-aware placement. Evaluation should measure Hot, Warm, Cool and Cold operations, tail latency, throughput, memory per worker and node, failure scenarios and cost per equivalent workload. DB eviction mitigates its own residency; server telemetry and network traffic management must control ingress pressure and whole-process OOM risk.

The [specifications](specifications/README.md) define current contracts and outstanding requirements. This whitepaper explains their architectural motivation, not an alternative normative API.

## Conclusion

CoCreateDB separates the database's logical structure from the infrastructure that persists, transports and protects it. Living leaves and independent runtime indexing provide the foundation; external workflows enable deployments to choose how data is acquired, retained, synchronized and secured.

The objective is to make data available where it is needed without coupling its identity to a particular physical location or requiring every application to adopt the same distributed architecture.

**Data should live where it is needed, when it is needed, for as long as it is needed.**

*Store it anywhere. Distribute it where authorized. Query it through one logical interface.*
