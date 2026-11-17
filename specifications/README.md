# CoCreateDB Specifications

Repository: `CoCreateJS/db` · Package: `@cocreate/db`

These specifications define the normative product contracts for CoCreateDB. Each document owns one responsibility; cross-references identify the authority for related behavior. Requirements describe the product architecture, not implementation status. Illustrative structures do not establish additional public APIs. A contract that leaves representation or policy unspecified does not authorize arbitrary incompatible choices.

## Storage model

- [Architecture](architecture.md) — system boundaries and relationships.
- [Scopes](scopes.md) — organization tenancy and logical addressing.
- [Root index](#runtime-root-index-indexjson) — external bootstrap manifest.
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

## Runtime root index: `index.json`

Each organization has a required external bootstrap manifest. The caller supplies `organizationId` in the operation payload; the bootstrap authority resolves the manifest for that authorized namespace. In a filesystem deployment the canonical layout is:

```text
<base>/<organizationId>/
  index.json
  data/
    <uuid>
  distribution/
```

The manifest provides the entry point into the database but is not itself a database-owned artifact. Ordinary CRUD, data artifact transfer, export and cloud persistence exclude it. The bootstrap authority supplies it through an explicit integration boundary; direct filesystem access by the database core is not required.

```json
{
  "version": "1.0.0",
  "root": "<uuid>"
}
```

`root` identifies the first independently addressable index/catalog artifact in `data/`. The top index makes all scopes reachable. The storages catalog is its first scope catalog, not an alternative namespace root. Neither physical directories nor inferred filenames determine the logical hierarchy.

`version` records package provenance. The version is embedded at build time and synchronized with `package.json` during release. Opening a namespace does not require package-version equality; the manifest has no `format` field. Encoding compatibility is governed by [persistence.md](persistence.md).

### Provisioning and reopening

Creation of a namespace requires an explicit provisioning handshake between the database and the external bootstrap authority. A new root is allocated, initialized and published according to the agreed provisioning contract. Opening an existing namespace uses its existing root; unavailable, malformed or inaccessible manifests and roots are failures, not instructions to create another database. Recovery of the manifest is an external responsibility. Root publication must not imply successful durable initialization unless the relevant durability conditions are satisfied.

**The entry point discovers the data. The data defines the database. Distribution makes the data available.**
