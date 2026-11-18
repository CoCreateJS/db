# CoCreateDB Specifications

Repository: `CoCreateJS/db` · Package: `@cocreate/db`

These specifications define the normative product contracts for CoCreateDB. Each document owns one responsibility; cross-references identify the authority for related behavior. Requirements describe the product architecture, not implementation status. Illustrative structures do not establish additional public APIs. A contract that leaves representation or policy unspecified does not authorize arbitrary incompatible choices.

## Storage model

- [Architecture](architecture.md) — system boundaries and relationships.
- [Scopes](scopes.md) — organization tenancy and logical addressing.
- [Bootstrap configuration](#bootstrap-configuration-indexjson) — external entry point.
- [Indexes](indexes.md) — recursive indexing and candidate planning.
- [Data](data.md) — UUID artifacts, complete objects and decoded state.
- [Distribution](distribution.md) — local placement, holders and acquisition.

## Mutation and lifecycle

- [CRUD](crud.md) — operation envelopes and scope handlers.
- [Mutations](mutations.md) — accepted operation application.
- [Reconciliation](reconciliation.md) — conflict precedence and convergence.
- [Replication](replication.md) — client and peer propagation.
- [Persistence](persistence.md) — workflows, serialization, encryption and recovery.
- [Edge cases](edge-cases.md) — cross-layer correctness requirements.

## Canonical terms

- **Organization** — the top-level logical data boundary identified by the
  existing `organization_id` value. It may represent a company, project, or
  another grouping chosen by the caller. “Namespace” can describe its
  isolation conceptually, but it is not a separate entity or hierarchy tier.
- **Scope** — a logical level in the data hierarchy:
  `storage → database → array → object`. Storage is the first scope and
  groups databases; each lower scope is resolved beneath its parent.
- **Index** — a lookup structure that resolves a scope name or key path to the
  next index or to an artifact UUID. Indexes and their segments are themselves
  artifacts.
- **Artifact** — one UUID-addressed value. An artifact holds the actual value
  for the scope it represents. A document is the complete application object
  stored at the `object` scope. The DB core keeps decoded state in memory;
  persistence owns durable source, destination, and representation.
- **Root** — only the bootstrap configuration in `index.json`; it is not a
  scope, index layer, or artifact. Its `root` field points to the first index
  artifact. An “index-tree root node” is a separate index-algorithm term.
- **Property path** — a JavaScript-style path within an object, indexed directly
  in the owning array's object index and resolved to the complete document UUID.
  It is not a CRUD scope or an independent artifact.

## Bootstrap configuration: `index.json`

Each organization has a bootstrap object. The caller supplies
`organization_id` in the operation payload; an external integration provides
the corresponding object. The DB core does not resolve a filesystem path or
choose a persistence provider. Bootstrap is separate from ordinary CRUD and
the persistence calls for UUID-addressed artifacts.

```json
{
  "version": "1.0.0",
  "root": "<uuid>"
}
```

`root` identifies the first independently addressable index artifact retrieved
through persistence. That index leads to the scope indexes and their artifacts. The first
storage scope index is separate from the bootstrap config and is not the root.
Neither physical directories nor inferred filenames determine the logical
hierarchy.

`version` records package provenance. The version is embedded at build time and synchronized with `package.json` during release. Opening an organization does not require package-version equality; the bootstrap object has no `format` field. Encoding compatibility is governed by [persistence.md](persistence.md).

### Organization bootstrap and reopening

Creation of an organization requires an explicit provisioning handshake
between the database and the integration that supplies its bootstrap object.
The object points to the first index artifact. Opening an existing organization
uses that pointer; unavailable or malformed bootstrap data and referenced
indexes are failures, not instructions to create another database. Recovery
and durable storage are outside the DB core and belong to the configured
integration.

**The entry point discovers the data. The data defines the database. Distribution makes the data available.**
