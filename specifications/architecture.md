# CoCreateDB Architecture Specification

## Scope

CoCreateDB is a JavaScript-native, storage-agnostic document database engine centered on an independently accessible indexing primitive. It separates logical data and query processing from physical persistence and network placement.

## Organization boundary

Each operation supplies `organizationId`, which selects an isolated namespace. One engine can serve multiple organizations. Each namespace has an externally supplied root, a collection of UUID-addressed artifacts and local distribution state. [Scopes](scopes.md) owns the address contract.

```text
<organizationId>/
├── index.json
├── data/
│   ├── <uuid>
│   └── <uuid>
└── distribution/
    └── <local operational metadata>
```

| Component | Role | Database cloud persistence |
| --- | --- | --- |
| `index.json` | External bootstrap manifest | Excluded |
| `data/` | Complete objects, catalogs, index roots/segments, durable reconciliation metadata | Eligible through configured workflows |
| `distribution/` | Local disk holder inventory and operational placement state | Excluded |

Only `data/` participates in database-managed cloud persistence and portable artifact export. The canonical layout describes artifact roles; providers may map addresses to their own storage representation. The core does not infer a path from an artifact's type or logical scope.

## Logical model

The root catalog leads to storage, database, array and object scopes. Keys are paths within complete objects. Indexes project those paths into recursive ordered structures whose terminal references resolve complete object UUIDs. Catalogs and index segments have independent UUIDs. Logical `_id` and physical UUID are distinct. See [data.md](data.md) and [indexes.md](indexes.md).

## Runtime ownership

The primary process owns authoritative decoded state, mutation ordering and distribution decisions. Each organization has one decoded `data` Map keyed by UUID. A working set is acquired on demand rather than requiring complete namespace hydration. Workers submit requests to the primary through the runtime integration. Any delegated persistence or serialization work uses stable versioned inputs and cannot independently mutate authoritative state. Worker delegation is not a prerequisite for correctness.

## Processing model

1. Authorize the organization and resolve its bootstrap and requested scopes.
2. Acquire necessary artifacts and resolve candidates through indexes where safe.
3. Verify query predicates and apply accepted mutations in memory through shared operators.
4. Initiate the client response when the requested result is complete; initiate peer propagation immediately alongside it for mutations.
5. Coordinate pending index maintenance and workflow persistence as separate observable effects.

Reads may wait for required artifacts. Pending index work must never omit a matching object. The response acknowledges in-memory processing, not crash durability or peer receipt.

## Integration boundaries

| Responsibility | Authority |
| --- | --- |
| Query/index structure | CoCreateDB indexing primitive |
| Query/update operators | `@cocreate/utils` |
| Conflict application | CoCreateDB reconciliation and mutations |
| Physical provider selection, encryption, retries | Persistence workflow |
| Bootstrap provisioning | External bootstrap authority |
| Routing and message delivery | Mesh integration |
| Local holder metadata | Distribution subsystem |
| Client local durability | Client integration |

Providers are independent of core algorithms. Application import, seeding and deployment tooling are outside the database contract; ordinary CRUD is sufficient to populate a provisioned namespace. No centralized distributed locking, full replication, multi-artifact crash atomicity or universal delivery guarantee is implied by this architecture.
