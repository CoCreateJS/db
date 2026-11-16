# CoCreateDB Storage Architecture Specification

## Scope

This specification defines the names and relationships of CoCreateDB's logical
scopes and physical storage roles. It describes the intended organization tree;
the current implementation may use a different layout until the migration in
[`NEXT_TASK.md`](../NEXT_TASK.md) is completed. Persistence behavior is defined
in [persistence.md](persistence.md).

## Logical scope hierarchy

Each request supplies an immutable `organization_id` namespace scope in its
payload. That ID selects the main namespace entry point. A persistence workflow
chooses its physical destination; if it is a local filesystem workflow, the
base path is configured there and no product-named directory is inserted
implicitly. The organization ID is distinct from child CRUD targets such as
storage, database, array, and object. See [scopes.md](scopes.md) for path rules.

Within an organization namespace, CoCreateDB data is addressed through these
scopes:

```text
storage → database → array → object → key
```

Each level is resolved from the level above it. A lower-level scope or artifact
is not an independent entry point into the organization tree.

## Physical roles and names

- **`index.json`** — the required top-level entry index. It is the root used to
  discover and resolve the rest of the organization tree.
- **`indexes/`** — contains index nodes reachable by following the entry index.
  A logical index starts at one root and may split into multiple nodes as it
  grows; the node files remain parts of that index, not separately named
  indexes.
- **`distribution/`** — maps data and index locations to their holders across
  clusters. It describes placement and is separate from the data itself.
- **`data/`** — contains persisted records and other data artifacts, organized
  under the storage/database/array/object/key scopes as required by the chosen
  physical encoding.
- **Artifact** — a general term for a stored file or payload. It is not a scope
  name and is not synonymous with an index node.

The intended per-organization logical layout, when represented by a filesystem
workflow, is:

```text
<workflow-base>/<organization_id>/
  index.json
  indexes/
  distribution/
  data/
```

## Reachability and ownership

The entry index is required to resolve scope and index roots. Index nodes are
reachable through the index tree. Distribution entries identify placement for
index or data artifacts. Data artifacts store the actual values. Do not make
each storage, database, array, or object directory a competing organization
entry point.

The physical encoding may evolve while preserving these names and relationships.
Changing the current on-disk format requires an explicit migration and peer
compatibility plan; existing data must not be rewritten implicitly.

## Relationship to other specifications

- [indexes.md](indexes.md) defines field-value indexes and candidate planning.
- [mutations.md](mutations.md) defines document state changes.
- [reconciliation.md](reconciliation.md) defines conflict precedence.
- [replication.md](replication.md) defines peer and client propagation.
- [persistence.md](persistence.md) defines durable data and local cache lifecycle.
