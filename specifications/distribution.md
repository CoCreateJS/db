# CoCreateDB Distribution Specification

## Scope

This specification defines the purpose and ownership of `distribution/` data.
The overall physical layout is summarized in [architecture.md](architecture.md).

## Role of `distribution/`

`distribution/` maps data and index artifacts to the cluster nodes that hold
them. It records location and availability; it does not contain document
payloads or replace the indexes used to filter query results.

For a filesystem persistence workflow, the organization-level path may include:

```text
<workflow-base>/<organization_id>/
  distribution/
```

This is an artifact role, not a core-owned filesystem path. The persistence
workflow maps distribution artifacts to its configured provider.

## Placement records

A distribution record identifies an artifact or partition and its current
holder node or nodes. Placement metadata must refer to the artifact using its
stable scope/address or partition identity, rather than copying the artifact's
contents into the distribution map.

Distribution state is distinct from:

- **Indexes:** structures that map field values to candidate object identities.
- **Data:** persisted object values and other data artifacts.
- **Replication:** messages that carry mutations or state between nodes.

## Discovery and acquisition

Distribution information supports locating holders and requesting missing
artifacts. An advertised artifact that no holder can supply is an availability
failure; it must not be treated as an empty index or absent document without
checking the relevant data source.

The exact record schema, consistency protocol, stale-holder cleanup, inventory
exchange, and recovery rules remain implementation contracts to define as the
distribution system evolves. Current prototype behavior and outstanding work
are recorded in `ARCHITECTURE.md` and `NEXT_TASK.md`.
