# CoCreateDB Specifications

This directory contains the authoritative contracts for CoCreateDB. Each
specification owns one responsibility and links to related contracts rather
than redefining them.

## Storage model

- [Architecture](architecture.md) — overview and relationships among all storage parts.
- [Scopes](scopes.md) — logical addressing from storage through key.
- [Root index (`index.json`)](#runtime-root-index-indexjson) — organization
  entry point and root manifest metadata.
- [Indexes](indexes.md) — per-field indexes, ordered nodes, schemaless values,
  and query candidate planning.
- [Data](data.md) — persisted documents and other data artifacts under `data/`.
- [Distribution](distribution.md) — cluster placement and holder mappings.

## Mutation and lifecycle

- [CRUD](crud.md) — scope/method routing, operation flows, and operator use.
- [Mutations](mutations.md) — how accepted operations change document state.
- [Reconciliation](reconciliation.md) — conflict precedence and convergence
  requirements.
- [Replication](replication.md) — peer and client propagation contracts.
- [Persistence](persistence.md) — workflow-owned durable storage operations.
- [Edge cases](edge-cases.md) — cross-layer problem scenarios, resolutions, and
  remaining work.

## Runtime root index: `index.json`

`index.json` is the required entry point inside each organization namespace.
`organization_id` is supplied by the caller. A persistence workflow chooses
where this namespace is stored. If that workflow uses the filesystem, the
namespace path follows `<workflow-base>/<organization_id>/`; see
[scopes.md](scopes.md) for path examples.

Storage, database, array, and lower scopes are resolved by following references
from this entry point; they are not separate filesystem roots. The root index
leads into index structures and scope catalogs, while document values are
`data/` artifacts and placement metadata is described by `distribution/`. These
are logical artifact roles; the persistence workflow chooses their physical
provider and representation.

The root manifest records the CoCreateDB package version that created it and a
generic reference to the top index node:

```json
{
  "version": "1.0.0",
  "root": "<top-index-node-id>"
}
```

There is no `format` field. `version` is informational provenance, not a schema
compatibility gate. Opening a database does not require the manifest version to
match the running package version. If an incompatible schema distinction is
needed in a future release, define it when that need exists instead of using
package version as an implicit format switch.

The root ID scheme is independent of the manifest version. UUID, ULID, or other
supported IDs are identifiers referenced by the tree; changing or supporting an
ID scheme does not by itself require a different root-manifest format.

The package version must be embedded as a static build-time value so source,
bundled, and minified builds can create manifests without reading `package.json`
at runtime. Keep that value synchronized with `package.json` through a build or
release script and validate synchronization there.

The root index is distinct from the field indexes documented in
[indexes.md](indexes.md). `index.json` is the top-level route into the tree;
`indexes/` contains nodes used to resolve field values to object candidates.

The new manifest replaces the current `format`/`storages` root metadata. The
migration from the existing `root.json` layout and references is tracked in
[`../NEXT_TASK.md`](../NEXT_TASK.md). This README is both the catalog for this
specifications directory and the root-index specification; it is not itself the
runtime JSON index.
