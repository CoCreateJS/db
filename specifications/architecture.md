# CoCreateDB Architecture Specification

## Scope

CoCreateDB is a JavaScript-native, storage-agnostic document database engine centered on an independently accessible indexing primitive. It separates logical data and query processing from physical persistence and network placement.

## Organization, scopes, indexes and artifacts

Each operation supplies `organization_id`; it identifies the organization
boundary, which may represent a company, project, or another caller-defined
grouping. There is no separate namespace tier above it. One in-memory DB engine
can serve multiple organizations. Within each organization, scopes are resolved
through indexes to UUID-addressed artifacts. `index.json` is bootstrap
configuration whose `root` value points to the first index artifact; “root” is
not a scope or a separate data layer. [Scopes](scopes.md) owns the hierarchy;
[data.md](data.md) owns artifact identity and value semantics.

```text
organization_id
├── bootstrap object     # provided outside the DB core
├── artifact values      # decoded values retained in memory
└── distribution state   # runtime placement knowledge
```

These are logical/runtime roles, not directories. The DB core requests values
from persistence and submits values to be saved; it does not select a provider,
resolve a physical path, or own durable I/O. Persistence defines those details.
An artifact contains the value for its addressed scope; indexes contain lookup
structures and resolve to child indexes or scope-value artifacts.

## Bootstrap and logical model

The bootstrap object is external input, not a data layer. Its
`root` field points to the first index artifact. That index leads to the scope
hierarchy `storage → database → array → object`. An index resolves to another
index or to an artifact holding the addressed scope value. The `object` scope
stores a complete document artifact. Its property paths live in the object
index and resolve back to the complete document UUID. Logical `_id` and
physical artifact UUID are distinct.
See [data.md](data.md) and [indexes.md](indexes.md).

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
