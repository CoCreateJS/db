# CoCreateDB — Architectural Comparison

**Version 0.4 — Living research and architectural positioning document**
**Root:** Architecture, terminology, data lifecycle and infrastructure convergence; not a performance ranking.

## 1. Purpose

This document compares CoCreateDB with established databases and adjacent distributed storage technologies. It preserves each project's terminology while distinguishing logical data representation, physical encoding, addressing, partitioning, persistence and synchronization.

CoCreateDB is an evolving architectural design. Its proposed features are not claims of implemented or independently verified capabilities. The other systems are described using their documented architecture; optional products and deployment modes may differ. No benchmark results or claims of architectural uniqueness are made here.

### 1.1 Architectural positioning

CoCreateDB proposes a storage-independent, memory-accelerated document database in which application objects, root catalogs and index segments share a unified addressing and value architecture. Rather than treating database records, files and distributed content as unrelated application resources, it aims to connect them through the same logical relationships.

Its value proposition is the combination of independently accessible indexing, lossless preservation of supported JavaScript values, demand-driven working sets, mesh synchronization and flexible persistence. CDN-assisted retrieval extends this vision as an emerging capability. The comparison also examines identity-independent addressing, ordered key-path indexes, and consolidation of application memory and execution responsibilities.

**Store it anywhere. Distribute it everywhere. Query it as one.**

## 2. Systems under consideration

| System | Architectural category | Primary relevance |
|---|---|---|
| CockroachDB | Distributed SQL database | Distributed ranges, coordination and consistency |
| Apache CouchDB | JSON document database | Documents, attachments and selective replication |
| Redis | In-memory data structure store | Memory execution, hash slots and client tracking |
| Apache Ignite 2 | Distributed database and data grid | Disk-backed memory and partition distribution |
| IPFS | Content-addressed peer-to-peer protocols | Independently addressed blocks and retrieval |
| SlateDB | Embedded object-storage database engine | Storage-independent compute and object-store persistence |
| CoCreateDB | Proposed storage-independent document database | UUID-addressed leaves, unified values, programmable persistence and demand-driven distribution |

IPFS and SlateDB are architectural references rather than direct equivalents to a general-purpose distributed document database.

## 3. Terminology and data representation

| System | Logical data unit | Representation | Addressing | Distribution unit |
|---|---|---|---|---|
| CockroachDB | Row, column, index | Typed SQL values encoded into key-value records | Encoded database keys | Range of ordered keys |
| CouchDB | Document, field, attachment | JSON documents and binary attachments; internal database-file encoding | Document ID, revision and attachment name | Shard containing documents; documents for selective replication |
| Redis | Key and value | Strings (binary-safe), hashes, lists, sets, sorted sets, streams; JSON where supported | Key | Hash slot assigned to a shard |
| Ignite 2 | Cache entry | Key-value data, typed objects or binary objects; internal pages | Cache key | Partition |
| IPFS | Block, DAG node | Raw bytes or codec-encoded structured data | Content identifier (CID) | Block |
| SlateDB | Key-value entry | Byte keys and values organized into LSM structures | Key | Application-defined partitioning; not a native distributed shard system |
| CoCreateDB | Storage, database, array, object, key, index, index segment | Shared lossless serialization of supported JavaScript values | Organization root, optional application identity and stable UUIDv7 leaf address | Independently addressable complete objects, catalogs and index segments |

### 3.1 Understanding the distribution primitives

- **CockroachDB range:** A contiguous interval of ordered keys, managed and replicated as a unit.
- **CouchDB shard:** A horizontal subset of a database's documents, with configured shard replicas.
- **Redis hash slot:** A logical partition number calculated from a key. Redis Cluster has 16,384 slots; one slot may represent many keys.
- **Ignite partition:** A group of entries assigned to cluster nodes through affinity mapping.
- **IPFS block:** A byte sequence addressed by its content-derived CID. It may contain raw file bytes or encoded data structure links.
- **SlateDB SSTable:** A sorted persistent table of key-value entries in its LSM storage architecture; not a node assignment.
- **CoCreateDB index segment:** A structure containing a bounded portion of an index and references to related content. Its UUID is an address, not a shard assignment.

These terms overlap in their purpose of organizing or locating data, but do not necessarily refer to the same layer of a system. A UUID and a hash slot, for example, are not interchangeable: one identifies content by a stable assigned address, while the other groups keys for routing.

### 3.2 Identity and addressing compared

Application identity, lookup keys and physical addressing are distinct concerns. CoCreateDB reserves `uuid` as a database-managed, immutable leaf address; application keys such as `_id`, `id` or `token` remain optional, with no privileged indexed lookup path. The designated generator is UUIDv7 ([RFC 9562](https://www.rfc-editor.org/rfc/rfc9562.html#section-5.7)), adopted through the shared UUID library. Its 48-bit Unix-millisecond timestamp permits chronological ordering of generated addresses, subject to clock behavior and within-millisecond generation policy. Updating a leaf does not change its address or generation timestamp.

| System | Identity or lookup convention | Comparison with CoCreateDB |
|---|---|---|
| CockroachDB | SQL primary key, including an automatically generated key when needed | Separates SQL access from internal encoded KV representation; primary-key identity remains part of the relational model |
| CouchDB | Document `_id` and revision | Direct document addressing exists, but document identity is defined by the document ID convention |
| Redis | Application-supplied key | Direct key access is a close analogue; CoCreateDB additionally maintains property indexes over complete objects |
| Ignite 2 | Cache entry key | Direct keyed access and secondary SQL access coexist; CoCreateDB proposes a separate universal leaf address |
| IPFS | Content-derived CID | Both support independent addressing; changed bytes generally imply a new CID, while a CoCreateDB address remains stable across updates |
| SlateDB | Application-supplied byte key | Direct key and range access at the storage-engine level; CoCreateDB adds document paths and separately addressed index leaves |
| CoCreateDB | Optional logical identity and reserved `uuid` | Application-defined identity is independent of database-managed leaf addressing |

The distinction is not whether competitors can store UUIDv7 values; many can. It is which layer owns the address, whether a separate application identifier is required, and whether that address remains stable as content changes. UUIDv7 is not a security credential or guarantee of collision-free generation; allocation must guard against overwrite. The timestamp reveals generation time and is not a global mutation order.

## 4. CoCreateDB data model

CoCreateDB separates logical values from their physical representation. The caller supplies `organization_id` as the top-level tenancy context; storage, database, array, object and key identify logical roots and paths. An array corresponds broadly to a document collection; a key corresponds to a property or nested path.

| Layer | Logical representation | Persistence representation |
|---|---|---|
| Organization bootstrap | Root reference and informational package version | Externally provisioned `index.json` |
| Root catalogs | References to logical roots | UUID-addressed serialized leaves |
| Index root and index of indexes | References and index metadata | UUID-addressed serialized leaves |
| Index segment | Ordered values, object references and boundaries | UUID-addressed serialized leaf |
| Application object | Complete object, including nested values | UUID-addressed serialized leaf |
| Nested key | Supported JavaScript value | Part of the containing object |
| Textual or binary content | String or supported binary value, as supplied | Part of the containing object |

### 4.1 Native values and content

Supported JavaScript values retain their data types and content across serialization and deserialization. These include objects, arrays, strings, booleans, null, explicit undefined, finite and non-finite numbers and binary bytes. The codec contract defines the supported type matrix and rejects unsupported values rather than silently losing information. No arbitrary JavaScript execution is implied.

Content is an ordinary application value. For example, an application may store JavaScript source as a string, or MP4 content as a binary value. A MIME type, where supplied, describes how the application interprets or delivers that content; it is not a physical storage format or a database type discriminator.

```js
{
    _id: "logical-id",
    name: "video.mp4",
    content: videoBytes,
    headers: { "Content-Type": "video/mp4" }
}
```

Here `videoBytes` represents a supported binary value, not a filename or a reference to an automatically extracted attachment. The complete object is serialized together. An application may instead model large content as a separate referenced object when independent acquisition or retention is needed. That is an explicit application modeling choice, not a mandatory file subsystem.

### 4.2 Physical representation

```text
<organization_id>/
  index.json
  data/
    <uuid>
    <uuid>
```

All database-owned durable leaves reside under `data/` with extensionless UUID addresses. Only `data/` participates in database-managed cloud persistence. Recipient awareness is transient routing state owned by Socket and Cluster; it is not a DB directory or persistence inventory.

One shared serialization/deserialization contract applies to all data leaves. Logical values are decoded in memory; persisted content is serialized bytes, not directly usable source files or media files. The serialization implementation is an architectural boundary, but a deployment uses a consistent compatible codec rather than choosing encodings independently for each leaf. Encryption is a separate protection layer.

Deep indexing does not split application objects into independently stored keys. Index roots and segments are independently addressable, while reads resolve and verify complete application objects. A small update to a large object may consequently rewrite that leaf.

## 5. Indexing and querying

| System | Indexing model | Query model |
|---|---|---|
| CockroachDB | Primary and secondary SQL indexes mapped into KV storage | SQL, relational queries and distributed execution |
| CouchDB | B-tree indexes, views and Mango indexes | Document retrieval, Mango selectors and views |
| Redis | Key lookup, data-structure operations and optional search indexes | Commands, JSON operations and search where supported |
| Ignite 2 | SQL indexes and cache-key access | SQL and key-value operations |
| IPFS | DAG links and content-addressed traversal | Content retrieval; not a general document query engine |
| SlateDB | LSM key ordering and internal lookup structures | Key lookup and range scans |
| CoCreateDB | Independently addressable, segmented, schemaless key indexes | Object CRUD, filtering, sorting, ranges and dot-notation queries |

CoCreateDB proposes independently accessible indexes organized by storage, database, array and key path, with one logical ordered index per indexed path. Mixed values retain their types; deterministic ordering and conservative candidate pruning preserve shared operator semantics. Segments maintain boundaries, lengths and links to adjacent segments. Query planning may use candidate counts to select a smaller starting set, loading only relevant index segments and objects. Unindexed queries require a fallback scan.

### 5.1 Flat key-path indexes and direct addressing

CoCreateDB treats `token`, `_id`, `name` and `company.address.office.number` as independently indexed paths. Nesting does not inherently add index traversal levels: each indexed path resolves through its ordered segments to the containing object's UUID. Indexed equality lookup latency can still vary by cardinality, selectivity, segment layout, memory residency and comparison cost. The design does not claim equal measured timings or that every path is necessarily indexed.

| Access model | Comparable mechanisms | CoCreateDB distinction |
|---|---|---|
| Primary or direct key access | CouchDB document IDs, Redis keys, Ignite cache keys, SlateDB keys, CockroachDB primary keys | Direct UUID resolution is independent of application-key identity |
| Secondary property access | CockroachDB secondary indexes, CouchDB Mango, Ignite SQL indexes, optional Redis search | Flattened key paths refer to independently addressable segments; nested path depth is not itself index depth |
| Content addressing | IPFS CID retrieval | Assigned stable UUID rather than a content-derived digest |

The proposed direct UUID access path bypasses ordinary application-key indexes and resolves the organization-scoped leaf directly. A resident leaf uses a Map lookup (expected constant-time internal access, not guaranteed end-to-end latency); a nonresident leaf follows normal acquisition. Root, authorization, leaf type and availability checks still apply. The reserved UUID need not be indexed again. How it is exposed in the result and the exact public payload selector remain open contracts.

### 5.2 Cardinality-aware routing and ordered boundaries

Ordered indexes and cost-aware planning are established techniques. CockroachDB uses SQL optimization and statistics; CouchDB Mango selects suitable indexes; SlateDB exploits ordered keys for range operations. Redis and Ignite offer access mechanisms appropriate to their key-value and optional query layers. IPFS traversal is not a comparable general-purpose query planner.

CoCreateDB's approach combines `first` and `last` values, segment references and `length` in the independently addressable index hierarchy. These boundaries permit pruning unrelated ranges and choosing a relevant traversal direction without sorting the entire dataset at query time. Chronologically sortable identifiers can make time-oriented ranges useful, but any supported ordered value can benefit from boundary-based routing.

Where logical semantics permit, the planner begins with a smaller candidate population and reduces it against remaining AND conditions. OR branches must preserve the union of qualifying candidates. Key-level counts are not necessarily predicate selectivity; a large index can contain a highly selective equality match. Segment counts and value boundaries refine the decision. This is a comparison of metadata organization and acquisition strategy, not a claim of superior optimization or measured speed.

## 6. Persistence architecture

| System | Durable representation | Memory relationship |
|---|---|---|
| CockroachDB | Pebble LSM storage on durable devices in the conventional architecture | Cached data and storage-engine execution |
| CouchDB | Database files and index structures | Disk-backed execution and caching |
| Redis | Optional RDB snapshots and AOF logs | Core Redis dataset primarily in memory |
| Ignite 2 | Native partition files, WAL and checkpoints when enabled | Disk-backed pages loaded into memory as needed |
| IPFS | Blocks persisted through node blockstores; pinning or other retention mechanisms | Retrieval and caching depend on implementation |
| SlateDB | LSM structures persisted in object storage | In-memory and optional local disk read caches |
| CoCreateDB | Independent serialized UUID leaves on local or remote persistence | Demand-driven working sets with durable backing |

### 6.1 Storage independence and programmable persistence

CoCreateDB separates leaf identity and logical traversal from physical placement. A UUID is resolved within its organization namespace regardless of which configured storage destination holds the leaf. References do not encode provider-specific paths.

The persistence boundary is a programmable function or workflow. Its logical operations are create, read, update and delete of a UUID leaf in authorized organization context. The following is illustrative, not a finalized public signature:

```js
persistence({ organization_id, method, uuid, content })
```

The workflow decides where and how to perform the operation; CoCreateDB does not impose a provider topology or require a separate storage mode for each provider. Local filesystems, removable media, network storage and cloud object storage can coexist.

| Policy | Example workflow behavior |
|---|---|
| Parallel retrieval | Query several destinations concurrently and return an acceptable valid revision |
| Sequential fallback | Try configured destinations in order until the leaf is found or the search is exhausted |
| Redundant writes | Write the same leaf to multiple destinations according to durability policy |
| Partitioned placement | Store distinct subsets of UUID leaves at different destinations |
| Tiered or offline storage | Retrieve from local, remote, archival or removable media as appropriate |

These are examples of programmable workflow policies, not claims that the engine supplies built-in implementations of all such policies. The workflow must respect revision freshness, integrity, authorization, failure and durability requirements. An absent leaf is distinct from an unavailable provider, a corrupt leaf or an unauthorized request. The fastest response is not necessarily the correct revision.

### 6.2 Leaf-level portability and partial availability

A subset of UUID leaves can be transferred, copied or relocated without rewriting its references, provided identities and valid content are preserved. Different subsets can reside on different disks, cloud providers or removable drives and can be reunited or retrieved through the same persistence interface. The database does not need to occupy a single physical location.

Traversal resolves references as needed. If required leaves are unavailable, the affected traversal is incomplete; their absence does not inherently corrupt the remaining leaves. Conversely, missing required data must not be silently treated as an empty result, and an inconsistent or malformed leaf is a separate integrity failure. Complete reconstruction requires a valid bootstrap reference, compatible serialization, authorized access and a consistent reachable set of required leaves.

The transferable unit is a leaf, not an arbitrary fragment of a serialized object. Individual index segments and complete objects may be relocated independently; a subset is not necessarily a self-contained database or consistent backup. Snapshot consistency and safe publication remain explicit responsibilities.

### 6.3 Encoding, protection and durability

One lossless codec serializes supported values into bytes and reconstructs them on read. Optional encryption operates separately, after serialization and before storage; decryption precedes deserialization. Provider selection does not alter the value contract. Neither serialization nor addressing is a security control.

The persistence workflow owns durable I/O; client response and immediate peer propagation are initiated after the in-memory result is ready, without awaiting the durable write. A response does not imply persistence or replica acknowledgment. Recovery, retries, stale-write protection and multi-leaf consistency require explicit guarantees.

## 7. Distributed execution and data placement

| System | Placement | Retrieval and synchronization |
|---|---|---|
| CockroachDB | Ranges with designated replicas, rebalancing and locality policies | Routes operations to appropriate range replicas; Raft coordination |
| CouchDB | Cluster shards and configured replicas; separately configured replication between databases | Changes feeds, continuous replication, selectors and filters |
| Redis Cluster | Hash slots assigned to shards | Slot-aware routing; asynchronous replication; optional client-side invalidation |
| Ignite 2 | Affinity-assigned partitions and optional backups | Distributed access and optional near caches |
| IPFS | Blocks held by participating providers | Peer retrieval and local retention; no universal replication requirement |
| SlateDB | Shared object storage; one writer per database and multiple readers | Readers access persistent state and cache locally; no built-in replication mesh |
| CoCreateDB | Proposed demand-driven placement of independently addressed content | Fetch from available peers or persistence, subscribe, synchronize, evict or retain |

### 7.1 CoCreateDB demand-driven working sets

A node is not required to hold a permanent partition merely because it joins the network. It may load a root reference, retrieve relevant index segments, resolve objects, retain frequently accessed data in memory and subscribe to relevant changes. Sustained demand may justify a local persistent copy; declining demand may allow eviction.

```text
Node A: indexes 1, 2 | objects A, C
Node B: indexes 2, 3 | objects B, C
Node C: indexes 4    | objects D, E
          fetch / subscribe / synchronize
                    |
         durable persistence providers
```

These are illustrative working sets, not finalized shard assignments. Any authorized node is intended to be able to participate in reads and writes, subject to the eventual coordination protocol. Demand-driven copies do not replace required durable copies or availability policies.

### 7.2 Memory ownership and application cache consolidation

Memory-first access is not unique to CoCreateDB. Redis is an in-memory data structure store with persistence options; Ignite combines distributed data and memory access with optional persistence and near caching. CockroachDB, CouchDB and SlateDB also employ storage-engine or read caching mechanisms. IPFS nodes may retain retrieved blocks locally. These mechanisms differ in root and guarantees and should not be equated with a worker's application-level object cache.

| Responsibility | Existing architectural alternatives | CoCreateDB design direction |
|---|---|---|
| Repeated lookup | Direct keys, indexed document queries, application caches | Reuse the indexed value already available, or retain a UUID for direct resolution |
| Cache coherence | Redis client tracking, Ignite near-cache coordination, application invalidation | Database-owned decoded working set with subscription-driven synchronization |
| Worker memory | Shared cache services, process-local caches, thread-shared state | One authoritative decoded leaf Map per organization at the node primary |
| Execution | Database servers, client workers, distributed compute facilities | Primary owns authoritative state and mutation order; workers may prepare operations, deliver results or execute eligible persistence work |

A token-based application need not maintain a token-to-ID Map simply to repeat a lookup. A query using the original token path resolves to the same leaf through the database's index; if faster repeated direct access is justified, the application may retain the UUID instead. This contrasts with a composed architecture that introduces additional reference maps or object caches, not with a claim that competitors require such maps. Redis key access and other indexed database queries may likewise eliminate redundant application mappings.

For illustration, ten workers each retaining the same 50 MB cache consume 500 MB of cached values. A single 50 MB authoritative working set removes up to 450 MB of duplicated cache contents, before accounting for index memory, IPC, transient copies and coordination. This is a hypothetical workload, not a competitor benchmark or a promised cost saving. A fair comparison should include shared-cache and native database alternatives, equivalent freshness guarantees, and total memory across all participating processes.

Centralized state ownership does not require centralized computation. Delegation may free the primary for authoritative reads, writes and routing, but IPC and serialization costs can offset the benefit. The primary remains responsible for validation and mutation ordering; worker offload is subject to measured benefit. Specialized caches or security-sensitive state may still be appropriate.

**Centralize the state. Distribute the work.**

## 8. Selective synchronization versus replication

Replication, partitioning, caching and subscription are separate mechanisms that can coexist.

- Partitioning divides a dataset into subsets.
- Replication maintains additional copies for availability, locality or recovery.
- Caching retains data for efficient subsequent access.
- Subscription delivers updates or invalidations to interested participants.

CouchDB already demonstrates selective document replication. Redis Tracking already demonstrates access-driven cache invalidation. Ignite demonstrates persistent partitioning with on-demand memory access. IPFS demonstrates independent peer retrieval.

CoCreateDB proposes combining those general ideas at the level of independently resolved complete objects and index leaves, with durability independent of the lifecycle of a compute node. Whether this combination yields a meaningful advantage remains a research question.

> Data should live where it is needed, when it is needed, for as long as it is needed.

## 9. Convergence of database, file storage and content delivery

### 9.1 One logical content architecture

A common distributed application architecture combines a database for structured records, a filesystem or object store for files, and a CDN for geographically distributed delivery. The application must maintain relationships between those resources, often coordinating separate identifiers, metadata, access policies and invalidation mechanisms.

CoCreateDB proposes bringing these relationships into one logical database architecture. Root catalogs, index segments and complete application objects share independently resolvable addresses. Textual and binary content are ordinary values within objects. The underlying persistence and delivery services can remain independent while the application manages them through one coherent data model.

| Responsibility | Common composed architecture | CoCreateDB design direction |
|---|---|---|
| Structured application data | Database records | UUID-addressed complete objects |
| File content | Filesystem, object store or database attachments | Textual or binary values in complete objects; separate objects when explicitly modeled |
| File metadata | Database record, filesystem metadata or object-store metadata | User-defined objects and indexed keys |
| Logical file paths | Directory paths, object keys or application mappings | Indexed application-defined keys independent of physical addresses |
| HTTP delivery policy | Application, web server or CDN configuration | Application-defined metadata interpreted by the serving layer |
| Geographical distribution | CDN, replicated storage and application caches | Mesh-first retrieval with optional CDN assistance |
| Change propagation | Application coordination, events or provider integrations | Selective subscription and version-aware synchronization |

This is a comparison of architectural composition, not a claim that established systems cannot offer integrated file storage and delivery. The database, storage provider, HTTP server and CDN retain their distinct technical responsibilities.

**One logical database. Independent physical locations. Independent ownership of your data.**

### 9.2 Distributed file metadata and delivery

A file-serving system needs more than file content when it manages application-defined routes, access permissions, response headers and delivery policies across multiple nodes. A shared metadata mechanism is required for consistent interpretation; it need not always be a separate database. Distributed filesystems, object stores and configuration services can already supply parts of this functionality.

CoCreate applications use a `files` array as an application convention for managing content and delivery metadata. CoCreateDB supports this convention through the same object and indexing model used for other application data.

```js
{
    _id: "673a1b2c3d4e5f60718293ab",
    name: "logo.svg",
    path: "/assets/logo.svg",
    content: svgText,
    headers: {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, max-age=3600"
    },
    description: "Public brand logo"
}
```

`svgText` represents the actual textual value. These fields are application-defined, not a required schema. A serving layer can resolve the indexed path, retrieve and decode the complete object, authorize access and emit the content with the appropriate HTTP headers. Public caching is appropriate only for explicitly eligible content.

Queries can use metadata indexes to narrow candidates, but retrieving the complete object also retrieves its embedded content. Independent content retrieval, retention or sharing requires an explicitly modeled separate referenced object. Large-object streaming and range access are separate serving and storage contracts; index segmentation does not provide them automatically.

The `files` array is not a separate database storage subsystem.

### 9.3 Comparison with existing content models

| System | Content-handling model | Relationship to CoCreateDB's proposal |
|---|---|---|
| CockroachDB | SQL records, byte values and application-managed external references | Structured metadata and transactions can coordinate file delivery; native file persistence is not the conventional row-storage model |
| CouchDB | JSON documents with named attachments and attachment HTTP endpoints | Close conceptual parallel for document-associated content; CoCreateDB uses complete UUID-addressed objects, including binary values, across configurable persistence environments |
| Redis | Binary-safe strings and data structures | Can hold file bytes or delivery metadata and serve as a cache; HTTP delivery and durable external file placement are separate concerns |
| Ignite 2 | Cache entries, typed/binary objects and optional persistence | Distributed content and metadata can be represented as entries; native file delivery is not its core persistence abstraction |
| IPFS | Content-addressed blocks, DAGs, file representations and gateways | Close parallel for distributed content retrieval; CIDs identify content versions, whereas CoCreateDB UUIDs can remain stable across updates |
| SlateDB | Byte-key/value records within object-storage-backed LSM structures | Can store metadata or bytes with independent compute; individual values are not ordinarily standalone native files in the underlying storage |
| CoCreateDB | Complete objects containing supported structured, textual and binary values | Proposed unified logical model spanning querying, file metadata, native content, mesh retrieval and optional edge delivery |

Other systems can be combined with storage and delivery infrastructure to achieve similar application outcomes. The comparison concerns the proposed native composition of these mechanisms, not exclusive possession of their capabilities.

## 10. Mesh-first retrieval and CDN-assisted distribution

### 10.1 Retrieval hierarchy

CoCreateDB's primary distributed retrieval mechanism is intended to be the mesh, not a CDN. Persistent direct node-to-node socket connections avoid repeated connection establishment and unnecessary application-level relays. Physical network routing still involves network hops.

| Retrieval environment | Proposed role |
|---|---|
| Local memory | Existing working dataset |
| Local persistence | Existing locally stored content where available |
| Nearby authorized mesh peers | Retrieve current or compatible working copies through persistent connections |
| CDN edge | Optional fallback for eligible cached content |
| Durable persistence | Retrieve from configured storage providers, including buckets and filesystems |

This is a policy-driven preference rather than a fixed sequence for every operation. Peer availability, latency, freshness and authorization may change the selected source. Consistency-critical reads may bypass caches altogether.

A newly provisioned node may retrieve only the indexes and objects required by its workload, retain them selectively, and subscribe to relevant changes. CDN-retrieved content may subsequently be shared through the mesh after appropriate version and integrity checks.

### 10.2 Volatility-aware placement

Access frequency and modification frequency are independent. Read-mostly data may be accessed constantly without changing frequently. Infrequently accessed data may be suitable for durable storage alone, or selective CDN caching if geographical delivery is beneficial. Archiving is a distinct retention strategy.

| Content characteristic | Potential distribution strategy |
|---|---|
| Frequently modified | Memory and active mesh synchronization |
| Frequently accessed, infrequently modified | Mesh and optional CDN caching |
| Immutable content | Long-lived version-specific CDN caching |
| Infrequently accessed | Durable persistence; optional edge caching on demand |
| Archived | Cold or offline durable storage |
| Consistency-critical or sensitive | Authoritative retrieval or restricted caching according to policy |

The same content may participate in several environments at once. Cache retention is not a replacement for durable storage or configured replication.

### 10.3 Existing global delivery infrastructure as a database retrieval layer

A CDN need not understand indexes, arrays, objects or query semantics to deliver independently addressed content. It may potentially deliver serialized index segments and complete application objects through the same general content retrieval mechanism.

For example, an authorized mesh node could retrieve a stable index segment from a CDN, resolve and decode a referenced application object, and retrieve a separate content object when the application models one. Query execution remains within CoCreateDB; the CDN delivers content rather than executing database operations.

This could extend existing global edge infrastructure to database retrieval, while also supporting conventional file delivery. The database and file-serving layers could share logical addresses, metadata and distribution policies instead of maintaining unrelated application models.

### 10.4 Freshness, consistency and security

A stable UUID is not an immutable content identifier. Updating content under a stable address can produce stale cached versions. Eventual consistency for ordinary application data may tolerate bounded propagation delays, but does not remove the need for reconciliation, deletion handling and version management.

Potential strategies include CDN purge APIs, expiration, conditional requests, version-specific cache keys, origin revalidation, authenticated retrieval and selective cache bypass. Provider invalidation is not necessarily instantaneous or atomic across related objects and indexes.

Delivery metadata and content may be cached independently at the serving layer or when modeled as separate leaves, but serving must evaluate applicable authorization and policy freshness. Revocation, deletion, residency requirements and security-sensitive decisions may require authoritative coordination. Encrypted content may be distributed without granting the CDN decryption capability, provided cache isolation, access controls and key management are appropriate.

A CDN is not an authoritative database replica, write coordinator or durability guarantee. CDN-assisted database distribution is an emerging capability requiring implementation and workload evaluation.

**The network doesn't dictate where data lives. Demand does.** Security, residency and durability policies constrain that demand.

## 11. Portability, security and ownership

| Dimension | CoCreateDB design direction |
|---|---|
| Physical namespace | Flat UUID-based addresses, independent of logical paths |
| Root discovery | Externally provisioned root reference |
| Relocation | Preserve addresses when moving consistent content between supported providers |
| Partial availability | Explicitly report unresolved, offline or inaccessible branches |
| Value portability | Preserve supported value types and content through a compatible shared codec |
| Encryption | Storage-layer and application-layer protection, with granular key ownership |
| Data custody | Permit independent physical placement and controlled reconnection |

Other systems also support backups, encryption, migrations and geographic placement. The distinction being investigated is the physical portability of individual CoCreateDB persistence entries and their logical relationships, not the presence or absence of general security or migration features.

Security depends on authorization, organization isolation, authenticated encryption where configured, key management and integrity validation. Reconnecting data requires compatible representations, valid references and authorized access.

## 12. Integrated data lifecycle and future evaluation

CoCreateDB aims to integrate querying, indexing, persistence, memory management, change propagation and distribution within a common execution architecture. This is an architectural objective rather than a demonstrated latency benefit.

Future evaluation should compare equivalent complete workloads rather than assume a fast isolated read or write determines the speed of an application. Established systems already integrate many lifecycle operations; their native capabilities should be used in any fair comparison.

Suggested future workloads include cold and warm reads, updates to indexed nested keys, durable writes, cross-node synchronization, subscriber delivery, decoded content delivery, node bootstrap, memory eviction, recovery and data relocation. Compare equivalent consistency, durability, authorization and delivery requirements. Record latency distributions, throughput, memory, network traffic, storage I/O and operational complexity. No measurements are included in this document.

Additional workloads should compare a conventional database + file store + CDN application with the proposed unified model, including metadata lookup, file delivery, cache misses, invalidation, origin traffic, policy changes and operational complexity. Results belong in `BENCHMARKS.md`; the architectural rationale belongs here.

### 12.1 Operation interfaces and execution boundaries

CoCreateDB uses `DB.send(object)` as a unified operation interface. The method and operation parameters reside in the payload, which participating components process and enrich through the lifecycle. Read, create, update and delete are operation semantics, not separate public database methods.

Other systems also offer common protocol or request interfaces: SQL for CockroachDB, HTTP requests for CouchDB, commands for Redis, and key-value or SQL APIs for Ignite. SlateDB exposes a storage-engine interface, while IPFS has content-oriented APIs. The useful comparison is the degree to which an operation representation can be carried across application, worker, primary, query and distribution boundaries without translation or redundant orchestration. A common payload does not eliminate transport serialization or guarantee lower latency.

Future tests should measure indexed top-level and nested equality queries, selective AND and OR predicates, ordered range access, direct resident and nonresident UUID resolution, repeated token retrieval with and without reference maps, and whole-node memory and throughput under different worker counts. Compare native direct-key and secondary-index access in alternatives, and include IPC, authorization, persistence and consistency costs. See `WHITEPAPER.md` v0.5 for the architectural rationale and illustrative memory economics.

## 13. Open architectural questions

- Finalizing direct UUID payload selection, response representation, and root/type validation.
- Evaluating UUIDv7 generator clock behavior, collision handling and shared-library compatibility.
- Measuring index routing selectivity, memory consolidation and worker delegation against equivalent native and composed alternatives.
- Discovering which peers or providers hold a particular UUID and version.
- Concurrent writes, atomic index maintenance, conflict resolution and recovery.
- Durable copy requirements independent of demand-driven cache placement.
- Subscription granularity, missed updates and reconnect reconciliation.
- Shared codec selection, supported type matrix and compatibility validation.
- Consistent snapshots, reference integrity, deletion and garbage collection.
- Encrypted indexing, key lifecycle and observable metadata.
- Explicit query completeness when relevant content is offline.
- CDN eligibility, version-aware retrieval, purge propagation and deletion behavior.
- Coordination of file content, delivery metadata, authorization and cache policy changes.
- Large-object delivery, range requests and independent content retention for explicitly referenced objects.
- Cost and latency tradeoffs between mesh retrieval, CDN delivery and direct persistence.

## 14. Conclusion

CockroachDB, CouchDB and Redis are primary database references for further investigation. Ignite, IPFS and SlateDB provide complementary architectural perspectives. Their terminology should remain intact rather than be translated into apparently equivalent CoCreateDB concepts.

CoCreateDB's design centers on independently addressable index segments and complete application objects, preserved JavaScript values, logical key-level relationships, programmable storage-independent persistence and demand-driven distributed working sets. Its potential distinction lies in how those mechanisms operate together, not in claiming that any individual mechanism is unprecedented.

Identity-independent addressing, flat indexed paths and direct UUID resolution extend this positioning into application access patterns. Consolidated memory and delegated computation extend it into runtime architecture. Each is a comparative dimension to evaluate against native alternatives, not a claim of unique functionality.

The convergence of structured values, textual and binary content and distributed delivery is a central part of this value proposition. A single logical content architecture may coordinate database operations, file-serving metadata and content distribution while preserving the specialized roles of the underlying infrastructure.

**Your data is not trapped inside a database. Your data is the database.**

**Store it anywhere. Distribute it everywhere. Query it as one.**

## 15. Documentation and research references

- [RFC 9562 — UUIDs, version 7](https://www.rfc-editor.org/rfc/rfc9562.html#section-5.7)
- [CockroachDB architecture design](https://github.com/cockroachdb/cockroach/blob/master/docs/design.md)
- [CockroachDB distribution layer](https://www.cockroachlabs.com/glossary/distributed-db/distribution-layer/)
- [CockroachDB Continuum architecture](https://www.cockroachlabs.com/blog/continuum-architecture/) — additional elastic architecture to investigate.
- [CouchDB technical overview](https://docs.couchdb.org/en/stable/intro/overview.html)
- [CouchDB shard management](https://docs.couchdb.org/en/stable/cluster/sharding.html)
- [CouchDB replication](https://docs.couchdb.org/en/stable/replication/intro.html)
- [CouchDB attachments](https://docs.couchdb.org/en/stable/api/document/attachments.html)
- [Redis Cluster specification](https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/)
- [Redis client-side caching](https://redis.io/docs/latest/develop/clients/client-side-caching/)
- [Redis persistence](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/)
- [Ignite 2 native persistence](https://ignite.apache.org/docs/ignite2/latest/persistence/native-persistence.html)
- [IPFS content identifiers](https://docs.ipfs.tech/concepts/content-addressing/)
- [IPFS data lifecycle](https://docs.ipfs.tech/concepts/lifecycle/)
- [SlateDB introduction](https://slatedb.io/docs/get-started/introduction/)

*Initial research snapshot: November 2026. Version 0.4 extends the comparison using WHITEPAPER.md v0.5, retaining the original competitor root and references. New comparative observations are architectural analysis based on that research and established access models; competitor documentation has not been independently reverified for this revision. Product editions, newer architectures and detailed configuration-dependent behavior require further verification as this comparison evolves.*
