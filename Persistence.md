# CoCreateDB — Local and External Persistence Architecture

**One Config. Hot/Warm local state. Cool/Cold external tiers.**

> **Status:** The current engine implements Hot memory, Warm local-disk residency, adaptive pressure mitigation, and memory/disk acknowledgement. Cool external Persistence and Cold archival storage are integrations. A separate Persistence Tree remains future architecture and is not implemented here.

CoCreateDB is a storage-agnostic JavaScript database engine built around independently addressable indexes and leaves.

Its architecture allows data to circulate throughout an ecosystem of independently operating database instances, adapting to consumption, available resources, and infrastructure changes.

The broader architecture describes data moving through three behaviors:

- **Hydration**
- **Pruning**
- **Pollination**

The current engine performs local Hot/Warm hydration and pruning. Pollination to peers or external providers remains an integration concern.

The current local tiers are **Hot** memory and **Warm** local disk. **Cool** external Persistence and **Cold** archival storage are outside the current engine. They are potential sources and destinations composed through external workflows.

---

## 1. Architecture

CoCreateDB is organized around a Config and one runtime index tree.

The Config establishes the structure and behavior of the database. The runtime tree represents its indexes; the leaf map provides direct in-memory UUID access. Warm files store local branches and leaves for write-through and recovery.

```
Config
└── Runtime index tree
    ├── Hot: resident leaves and branches in memory
    └── Warm: local branch and leaf files

Cool: external Persistence workflows/providers (integration)
Cold: long-term archive (integration)
```

Every index branch can contain child branches or leaf references. The current runtime does not have a second `tree.persistence` or a provider-specific persistence tree.

---

## 2. Terminology

| Term            | Definition                                                       |
| --------------- | ---------------------------------------------------------------- |
| **Config**      | Defines the root, structure, and behavior of the database.       |
| **Root**       | Defines a structural boundary.                                   |
| **Root Branch**  | Establishes the entry point of an index structure.               |
| **Index**       | An ordered map that references child indexes or data leaves.     |
| **Tree**        | The recursive structure of root branches and branches.            |
| **Branch**      | An index node that references child branches or data leaves.     |
| **Leaf**        | An independently addressable data record.                        |
| **Hydration**   | Expands and updates the Tree.                                    |
| **Pruning**     | Reduces the Tree.                                                |
| **Pollination** | Enables connectivity and sharing of data.                        |

### Temperature tiers

| Tier | Meaning | State |
| --- | --- | --- |
| **Hot** | Memory | Resident leaves and indexes currently available in RAM. |
| **Warm** | Local disk | The instance's local working set, used for recovery and offload. |
| **Cool** | External Persistence | A configured persistence provider outside the local DB instance. |
| **Cold** | Archive | Long-term archival storage, when a deployment provides it. |

The current core implements Hot and Warm state management. Cool and Cold name later integrations; this pass does not add providers or a Persistence Tree.

These terms describe the core architecture.

Memory allocation, disk allocation, access counters, transport mechanisms, storage providers, and other implementation details are discussed separately.

---

## 3. Config

The DB Config establishes the root of CoCreateDB.

It defines the database's identity, structure, and behavior, including:

- Identity and version.
- Roots.
- Root definitions and, in the future, root-branch references.
- Memory configuration.
- Disk configuration.
- Persistence configuration.

The Config is an independently addressable object.

It is not inherently a file, nor is its identity determined by a filename or extension.

How the Config is stored is outside the responsibility of the Config itself.

### Roots

Roots establish the structural boundaries within the database.

The Config defines the available roots. Stable references from each root to its root branch are a planned part of the complete index catalog.

```
Config
├── Identity
├── Version
├── Memory
├── Disk
├── Persistence
└── Roots
    └── Root
        └── Root Branch Reference (planned)
```

The current Config stores root definitions and structural leaf identities. Stable root-branch references are not yet persisted.

### Shared configuration

Database instances operating within the same ecosystem share an authoritative DB Config.

Individual instances may apply operational overrides appropriate to their resources and responsibilities.

The default requested DB budget is 25% of total system memory and is capped by memory available at startup. Deployments may tune that target after benchmarking; the DB target does not reserve or cap memory for the rest of the server process.

Such local operational settings do not need to modify the shared Config.

### Local base layout

Each DB instance has one base directory. It is not nested under an organization ID: organization IDs are root values defined by the DB Config.

```text
<base>/
├── config.json
├── branches/
└── leaves/
```

`config.json` stores the version, root definitions, structural leaf catalog, and each field/type index route's current root branch UUID. Branch files in `branches/` include root, interior, and terminal branches; leaf files in `leaves/` contain the data leaves. A route is reopened from its saved root UUID, and child branch UUIDs remain the references used for traversal.

The Config is written to the base in every mode. Root registration, root deletion, and configuration updates persist changes to it. On startup, `adaptive` and `disk-first` load an existing Config when present; otherwise the DB uses the supplied Config or defaults and writes the result. `disk-cache` clears the DB-managed base contents (`config.json`, `branches/`, and `leaves/`) on startup, then initializes and writes a fresh Config from the supplied Config or defaults.

If no base directory is supplied, CoCreateDB creates one under the operating system's temporary directory. Restart recovery requires reusing a stable base path.

On a successful in-memory acknowledgement, CoCreateDB queues local writes after returning the response. It writes changed leaves and changed branches, then saves the route-root catalog. `flushDisk()` drains queued work and pending index updates for an orderly shutdown or an explicit durability checkpoint. Disk acknowledgement waits for the affected local writes; memory acknowledgement does not wait for disk. Adaptive eviction also writes the evicted leaf or terminal branch. A process interruption before queued writes finish can lose the latest changes.

On restart, the Config restores the structural roots and route-root UUIDs. Index branches are loaded from those saved UUIDs, and leaves are hydrated from their UUID-addressed files as traversal requires. The engine does not rebuild all field indexes or generate replacement route UUIDs during startup.

### Local-state mode and acknowledgement

`mode` and `acknowledgement` are independent options. A mode determines how the instance manages its Hot and Warm local state. An acknowledgement determines how far a request must progress before CoCreateDB returns its response. Selecting a mode never selects or changes an acknowledgement automatically.

| Mode | Local-state behavior |
| --- | --- |
| `adaptive` | Default. Keep a working set Hot in memory and use Warm local disk as pressure requires. Local disk state is retained across restarts. |
| `disk-first` | Use Warm local disk as the starting point for each request, hydrate the needed working set into Hot memory, then write and prune local state after the operation. |
| `disk-cache` | Use adaptive Hot and Warm local state, but clear the DB-managed base contents on startup and initialize from the supplied Config or defaults. External Cool Persistence and Cold archives are not cleared. |

Adaptive memory pressure uses a soft RSS budget. The default requested allocation is 25% of total system memory, capped by memory available to the OS at startup (Linux `MemAvailable`, falling back to the OS free-memory value). Pressure stages are 10%, 20%, 30%, 40%, 50%, 60%, 80%, and 90% of that effective budget. Each eviction pass removes the entire lowest eligible weight group from branches and leaves independently; item counts are not fixed. At 90% pressure, adaptive request handling temporarily uses disk-first behavior, returning the in-memory result and then writing and pruning local state. Above 90%, each request can signal another weighted pass; there is no separate 100% stage. The DB returns to adaptive behavior after pressure falls below 87.5% of budget, using the default 2.5 percentage point hysteresis.

| Acknowledgement | Response guarantee |
| --- | --- |
| `memory` | The operation has been applied to the Hot leaf state and its result is available. |
| `disk` | The operation's affected local state has been written to the Warm local-disk tier. The mode independently determines whether it remains Hot. |
| `persistence` | A configured external Persistence provider has acknowledged the operation. This acknowledgement requires the external persistence integration; it is not provided by local disk writes. |

The acknowledgement choice does not change `mode`, and the mode does not imply a durability level. For example, `disk-cache` with a disk acknowledgement confirms a Warm local write, not survival across restart. A Cool Persistence acknowledgement is distinct from a disk acknowledgement.

The current core supports the local `memory` and `disk` acknowledgement paths. External Persistence acknowledgement remains a future integration. Local state management does not create a Persistence Tree.

---

## 4. Runtime Tree

The runtime index tree is the live representation of indexes established from the Config and leaves. It operates on Hot references and can resolve Warm branch and leaf files as needed. Adaptive mode is the default; pressure can move eligible state from Hot memory to Warm local disk. The engine does not maintain a separate in-memory Persistence Tree.

The recursive Persistence Tree described in later sections is a future design direction only. External Cool providers remain opaque to the current local tree and are called through workflows.

---

## 5. Hot and Warm Local State

Hot represents resident indexes and leaves in memory. Warm represents their DB-managed local-disk files. Together they form the current instance's local working and recovery state.

Its contents evolve according to consumption and available resources.

It may contain:

- Indexes.
- Leaves.
- Previously consumed data.
- Newly created or updated data.

The default requested memory budget is 25% of total system memory, capped by memory available at startup. This is a soft target for DB-managed residency, not a hard cap on process RSS. At high pressure adaptive handling uses disk-first request processing while weighted eviction writes and sheds eligible Hot leaves and branches. Network ingress and whole-process OOM control belong to server telemetry and traffic management, not the DB's residency policy.

The explicit modes are `adaptive` (default), `disk-first`, and `disk-cache`. Disk-cache clears the DB-managed base on startup; the other modes retain it when a stable base directory is reused. The default acknowledgement is `memory`; `disk` waits for affected Warm writes. Mode and acknowledgement are independent, instance-level options.

---

## 6. Proposed Cool Persistence Tree (Future)

The current engine has no Persistence Tree or external persistence provider. This section describes a possible future Cool-tier representation.

**When data needs to be persisted, the branch hydrates and prunes based on the necessary changes, then pollinates those changes to persistence.**

If implemented, that tree could represent only the portion of a provider-backed structure needed for an operation, rather than the complete external dataset.

Its lifetime depends on the work being performed. The hydrated structure may be pruned after an operation or retained temporarily for subsequent operations.

It would be separate from current Hot/Warm residency and would not make the local index tree provider-aware.

The persistence destination is determined by the configured persistence implementation.

---

## 7. Future Provider Root Mapping

An external provider integration may reuse structural root UUIDs from the Config while maintaining provider-specific state.

That mapping and its recovery semantics are not implemented by the current DB.

Their indexes may differ in:

- Structure.
- Depth.
- Contents.
- Internal branch identities.
- Locally available leaves.

For example:

```
Tree
├── local
│   └── Root Branch (A)
│       ├── Index (B)
│       │   └── Leaf → Leaf (1)
│       └── Index (C)
│           └── Leaf → Leaf (3)
└── persistence
    └── Root Branch (A)
        ├── Index (D)
        │   ├── Leaf → Leaf (1)
        │   └── Leaf → Leaf (2)
        └── Index (E)
            ├── Leaf → Leaf (3)
            └── Leaf → Leaf (4)
```

Both tiers begin from Root Branch A.

Their internal indexes are independent because they may represent different datasets.

The Local tier cannot replace a persistent index with its own index because its contents may represent only a subset of the persistent dataset.

Each branch independently hydrates and prunes its structure according to its responsibilities.

### Stable root identities

Root index identities must remain consistent.

Internal indexes may be reorganized, expanded, or reduced without changing the root identity used to enter the structure.

If an internal operation requires a different physical root, the stable root reference must continue resolving correctly.

---

> **Implementation boundary:** Sections 8–26 continue the proposed provider-backed Local/Persistence Tree design. They are future architecture, not current engine behavior. The current engine has one runtime index tree with Hot/Warm local residency; consult the [project README](README.md) and [current specifications](specifications/README.md) for its implemented contract.

## 8. Branches and Leaves

A branch is a recursively navigable part of the Tree.

Branches may contain other branches and leaves.

```
Branch
├── Branch
│   ├── Leaf → Leaf
│   └── Leaf → Leaf
└── Branch
    ├── Branch
    │   └── Leaf → Leaf
    └── Leaf → Leaf
```

There is no fixed depth.

The same recursive implementation applies throughout the Tree.

### Indexes and leaves

An index is the searchable field/type structure. Its root and child index nodes are branches; terminal entries reference data leaves.

The in-memory Tree begins at a root branch and may contain child branches. Terminal branch entries reference data leaves.

Leaves contain the actual data and are stored independently of indexes.

Indexes and leaves are distinct structures, maintained in separate storage directories.

---

## 9. Leaf Identity

Every leaf has an independently addressable identity.

That identity remains consistent regardless of:

- Which primary tier references the leaf.
- Which database instance consumes it.
- Where the leaf is stored.
- How it becomes available.
- How often it is hydrated or pruned.

An existing leaf does not receive a new identity simply because another database instance consumes it.

### Directional references

Indexes reference leaves.

Leaves do not need to maintain persisted references to the indexes or branches that reference them.

```
Index
  └── Leaf Reference
          ↓
       Leaf
```

This direction is important.

If an index is reorganized, the database can update the index without modifying every leaf it references.

### Leaf metadata

Leaves retain the metadata required to identify their root and structural ownership.

In the previously inspected implementation, this includes properties such as:

- `uuid`
- `root`
- `parent`

Structural leaves may also contain properties such as `name`, while application data may contain `_id`.

The `parent` reference identifies structural ownership within the root hierarchy. It is not a persisted backward reference to an indexing branch.

The current runtime may maintain temporary internal index references for its own operations. These are distinct from persisted leaf references.

---

## 10. Hydration

Hydration expands and updates the Tree.

It includes creating, populating, and modifying branches and leaves.

Hydration occurs when data is needed or when existing data changes.

It applies equally to Local and Persistence.

A branch can hydrate independently without requiring the complete surrounding Tree to be hydrated.

Hydration describes the resulting change to the Tree, not the mechanism through which the data becomes available.

---

## 11. Pruning

Pruning reduces the Tree.

It removes branches or leaves from a particular active context.

Pruning can occur because:

- Data is no longer required locally.
- Available resources are constrained.
- A branch is being reorganized.
- Data is permanently deleted.

Pruning the Local tier does not necessarily affect the persistent dataset.

Pruning the active state of the Persistence tier does not necessarily delete durable data.

The distinction is whether the operation releases an active representation or intentionally deletes underlying data.

The same recursive Tree implementation supports both.

---

## 12. Pollination

Pollination describes the connectivity and sharing of data throughout the ecosystem.

It enables data to become available wherever it is consumed.

Pollination does not prescribe how data is transferred, where it originates, or which transport or storage mechanism participates.

It does not require CoCreateDB to maintain centralized awareness of where every leaf exists.

Hydration and pruning describe changes within the Tree.

Pollination describes the interconnectivity that allows data to circulate between environments.

---

## 13. Resource Management

CoCreateDB operates within configurable resource allocations.

Both Local and Persistence consume resources while their branches and leaves are active.

Resource management determines when data should remain active and when pruning is appropriate.

The resource management algorithm is separate from the core Tree terminology.

### Access properties

The implementation can maintain properties that describe how branches and leaves are used.

For example, the previously inspected implementation includes:

- `viewed` — a numeric access counter.
- `touch()` — an operation that increments the counter.

These properties can inform resource management without becoming architectural primitives.

The precise meaning of an access, the frequency of counter updates, and the algorithm used to prioritize data are implementation concerns.

### Memory

Both primary tiers may contain active data in memory.

Configurable memory limits determine how much data can remain active.

When resource limits are approached, less important branches and leaves can be pruned.

### Local disk

The Local tier may retain data on local disk after it is no longer active in memory.

Disk allocation can also influence pruning.

CoCreateDB manages its use of local disk, not how that disk is provisioned by the operating system.

### Persistence

The Persistence tier may retain frequently needed indexes and leaves in its active state.

This reduces repeated requests to the persistence provider.

Resource management must preserve pending changes and the integrity of persistent indexes.

---

## 14. Data Temperature

Data naturally transitions between different levels of availability as it is consumed.

These levels are descriptive, not separate architectural components.

| Temperature | Typical availability                    |
| ----------- | --------------------------------------- |
| Hot         | Active in memory.                       |
| Warm        | Available on local disk.                |
| Cool        | Available through external Persistence. |
| Cold        | Available through long-term archival storage. |

An leaf may exist at multiple levels simultaneously.

For example, a leaf Hot in memory may also have a Warm local-disk copy, a Cool external-Persistence copy, and a Cold archival copy.

As consumption decreases, active representations can be pruned while durable data remains available.

As consumption increases, hydration makes the data active again.

The Tree does not require a separate component for each temperature.

---

## 15. Persistent Operations

The Persistence tier maintains the indexes required to represent the persistent dataset.

Because Local and Persistence may contain different datasets, persistent index changes must be applied within the Persistence tier.

For example, a newly created leaf may already exist within Local but still need to be incorporated into the persistent index structure.

The Persistence tier hydrates the relevant indexes, updates its structure, and preserves the affected data through the configured persistence implementation.

### Independent index structures

The Local tier must not overwrite a persistent index with a partial local index.

Instead, each branch updates its own structure.

### Grouped changes

Multiple operations affecting the same persistent branches can be grouped.

Frequently accessed branches can remain active, reducing repeated requests to persistence.

Only the affected portions of the Tree need to participate.

### Durable changes

Changes awaiting persistence must not be discarded through pruning before their durability requirements are satisfied.

The implementation must account for concurrent changes, interrupted operations, and recovery.

---

## 16. Query Completeness

The Local tier may represent only a subset of the persistent dataset.

A locally available result does not necessarily represent the complete result of a query.

When a query requires data beyond the Local tier, the relevant persistent indexes must participate.

The shared root branch references provide consistent entry points, while each branch follows its own internal structure.

Only the branches and leaves required to satisfy the query need to be hydrated.

The implementation must distinguish between:

- A query whose complete result is known.
- A query whose locally available result may be incomplete.

---

## 17. Initialization

When a CoCreateDB instance initializes, it establishes its Config and Tree.

The Config supplies the structural definitions and root branch references.

The Tree begins with its Local and Persistence tieres.

```
Config
  ↓
Tree
├── local
└── persistence
```

Neither branch requires complete hydration at initialization.

Branches and leaves become available as they are needed.

### First initialization

If an authoritative Config already exists, the instance uses it.

If no authoritative Config exists, an initiating instance may establish one.

Concurrent initialization must preserve a single authoritative Config.

### Existing instances

An instance joining an existing ecosystem uses the shared Config and root branch identities.

Its internal branches develop independently through hydration, pruning, and pollination.

---

## 18. Config Synchronization

The DB Config is shared across participating database instances.

Changes to the Config use CoCreate's existing CRUD and Service Send architecture.

The originating instance establishes the authoritative change and communicates the relevant modification to other instances.

Receiving instances apply the change without independently repeating the same persistence operation.

### Incremental changes

A Config modification does not require broadcasting the complete Config.

Existing CRUD operations can communicate the affected properties.

### Revisions

Config revisions allow instances to identify outdated or missed changes.

An instance that detects a gap can reconcile its Config against the authoritative state.

### Stable roots

Ordinary index changes should not require Config modifications when root branch identities remain stable.

The Config should change when its actual structure or configuration changes, not whenever a branch is reorganized.

---

## 19. Data Circulation

Data circulates according to consumption.

Database instances do not require predetermined placement of every leaf.

When an instance needs data, the relevant portion of its Tree is hydrated.

Once available, that data becomes part of the instance's active dataset.

As other instances consume the same data, it naturally becomes available elsewhere in the ecosystem.

Changes are communicated through CoCreate's existing CRUD and Service Send architecture.

CoCreateDB does not independently duplicate subscription awareness already established across servers, workers, and clients.

Each database instance maintains its own active dataset.

Not every instance needs to contain the same leaves or indexes.

---

## 20. Static Infrastructure

CoCreateDB can operate on infrastructure that remains active for extended periods.

The Local tier evolves continuously according to consumption and resource availability.

Frequently used data remains active.

Less frequently used data becomes eligible for pruning.

Local disk can retain data beyond its active lifetime in memory.

The Persistence tier maintains access to the durable dataset independently of the Local tier's active contents.

This allows long-running database instances to operate within defined resource allocations.

---

## 21. Ephemeral Infrastructure

CoCreateDB is designed to operate with infrastructure that may be created, replaced, relocated, or removed.

New instances establish their Config and hydrate their Trees according to consumption.

Existing instances can share data through pollination.

As infrastructure is removed, its locally retained data may disappear with it.

That is acceptable only when the data is already durably preserved or its pending changes have been safely transferred.

```
Infrastructure evolves.
Trees hydrate and prune.
Data follows consumption.
```

The database does not need to migrate every locally retained leaf whenever an instance is replaced.

New infrastructure hydrates the data it needs.

---

## 22. Geographic Data Circulation

Data naturally follows geographic consumption.

As infrastructure becomes available in different regions, instances hydrate their Trees according to local activity.

Frequently consumed data can become available closer to where it is needed.

When demand changes, new instances hydrate the relevant data while older instances are pruned or removed.

This behavior does not require CoCreateDB to maintain a separate geographic placement manager.

It emerges from consumption, hydration, pruning, and pollination.

---

## 23. Direct Persistence

The Persistence tier may operate directly against a configured persistence provider.

```
CoCreateDB
└── Tree
    ├── local
    └── persistence
        └── Persistence Provider
```

The Tree remains independent of the provider.

The provider may be object storage, a filesystem, or another compatible persistence implementation.

Frequently accessed persistent indexes can remain active according to resource availability.

Grouped operations can reduce repeated interactions with the provider.

This allows CoCreateDB to operate without dedicated persistence infrastructure.

---

## 24. Dedicated Persistence Infrastructure

At larger scales, dedicated CoCreateDB instances may be used to handle persistent operations.

These instances use the same engine and Tree architecture.

```
Application Infrastructure
          ↕
Dedicated CoCreateDB Instances
          ↕
   Persistence Provider
```

Dedicated instances can retain frequently modified persistent indexes in memory and on local disk.

This can reduce direct requests to external persistence providers.

The persistence infrastructure may be scaled independently of application infrastructure.

### Durability

If dedicated instances maintain persistent indexes without continuously writing those indexes to durable external storage, the system must provide equivalent durability and recovery guarantees.

This may require replication, durable logs, snapshots, or other mechanisms.

The choice of implementation does not change the Tree's structure.

Dedicated persistence infrastructure is optional.

---

## 25. Persistence Economics

Persistence providers may charge according to:

- Stored capacity.
- Request volume.
- Data transfer.
- Additional storage features.

At larger scales, repeated interactions with persistent indexes may become a significant expense.

CoCreateDB can reduce these interactions by retaining frequently used persistent branches, grouping operations, and optionally using dedicated persistence infrastructure.

The appropriate deployment model depends on actual workload, resource requirements, and provider costs.

CoCreateDB should be able to evolve between direct and dedicated persistence without changing its fundamental Tree implementation.

---

## 26. Data Integrity

Hydration, pruning, and pollination must preserve the integrity of indexes and leaves.

Independent branch state does not remove the need for consistency within the persistent dataset.

The implementation must account for:

- Concurrent persistent operations.
- Pending changes.
- Interrupted operations.
- Recovery.
- Consistency between indexes and referenced leaves.
- Safe infrastructure removal.

### Persistent index integrity

Persistent indexes must reflect the complete persistent dataset, not merely the locally available subset.

When a persistent index changes, the affected structure must remain valid and recoverable.

### Pending changes

Pruning must not discard changes that have not satisfied their durability requirements.

### Concurrent changes

Multiple instances may modify the same persistent dataset.

The persistence implementation must prevent concurrent operations from silently overwriting one another.

### Infrastructure removal

Before an instance is removed, pending durable changes must be completed or safely transferred.

---

## 27. Implementation Direction

The following represents the proposed architectural update, not a claim that these changes have already been implemented.

### Config

- Establish the DB Config as the root.
- Define roots and root branch references within the Config.
- Maintain stable root branch identities.
- Support shared configuration with instance-specific operational overrides.
- Support incremental Config synchronization.

### Tree

- Establish one Tree with `tree.local` and `tree.persistence`.
- Maintain independent internal state within both primary tiers.
- Use the same recursive implementation throughout.
- Standardize branch and leaf terminology.
- Preserve consistent root branch references.

### Leaves and indexes

- Preserve leaf identity across environments.
- Maintain directional index-to-leaf references.
- Avoid persisted backward references from leaves to indexing branches.
- Allow Local and Persistence to maintain different internal index structures.
- Preserve persistent index completeness.

### Hydration and pruning

- Support hydration throughout both primary tiers.
- Support pruning throughout both primary tiers.
- Distinguish releasing active data from permanent deletion.
- Protect pending changes from unsafe pruning.
- Support partial hydration without loading complete datasets.

### Resource management

- Evaluate existing access properties such as `viewed` and `touch()`.
- Define the resource management algorithm separately from the core terminology.
- Apply memory constraints across both primary tiers.
- Manage local disk usage.
- Support independent retention decisions within Local and Persistence.

### Persistence

- Hydrate the relevant persistent indexes before modifying them.
- Apply persistent changes to the Persistence tier rather than copying partial Local indexes.
- Group operations affecting common persistent branches.
- Preserve index and leaf integrity.
- Support direct persistence and optional dedicated persistence infrastructure.

### Pollination

- Reuse CoCreate's existing communication architecture.
- Avoid duplicate database-level subscription awareness.
- Allow indexes and leaves to circulate according to consumption.
- Preserve leaf identity and root boundaries.

### Infrastructure

- Support static and ephemeral deployments.
- Allow new instances to hydrate their Trees incrementally.
- Protect pending durable changes during infrastructure removal.
- Support independent scaling of application and persistence infrastructure.

---

## 28. Architectural Principles

1. One authoritative Config.
2. One Tree per database instance.
3. Two primary tiers: Local and Persistence.
4. Shared root branch identities.
5. Independent internal branch structures.
6. Recursive branches and leaves.
7. Consistent leaf identity.
8. Directional index-to-leaf references.
9. Hydration and pruning throughout the Tree.
10. Pollination through existing connectivity.
11. Local memory and local disk.
12. Storage-agnostic persistence.
13. Demand-driven data circulation.
14. No duplicate distribution or subscription management.

---

## Conclusion

**The Config defines the structure.**

**The indexes organize the data.**

**The Tree hydrates, prunes, and pollinates.**

**The infrastructure follows demand.**

**The data follows consumption.**
