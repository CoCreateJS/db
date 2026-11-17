# CoCreateDB Distribution Specification

## Local distribution state

`distribution/` contains the local operational metadata used to manage and maintain distribution of files held on local disk. It is separate from `data/`, is not a portable database artifact, and is excluded from database cloud persistence and export. The local distribution subsystem owns its inventory lifecycle and location; it does not create a second durable database persistence path.

```text
<organizationId>/distribution/
    <local operational metadata>
```

Durable reconciliation and deletion records belong in `data/`. The local inventory is distinct from remote-peer inventory learned in memory; remote inventory is not persisted by default.

## Holders and discovery

Holder records identify artifacts using exact organization and UUID context, location, availability and revision information. A cached holder and a durable holder are not interchangeable; advertisements indicate what can actually be supplied. Discovery supports targeted requests, inventory exchange, session/reconnect handling, stale-holder cleanup and bounded timeouts. Record representation and restart reconstruction follow the distribution integration contract.

## Demand-driven acquisition

A node opens a namespace using its external bootstrap and acquires necessary root/catalog paths, index segments and objects on demand from authorized available sources. It retains decoded working-set values in the organization Map. Full replication and whole-index hydration are not required. Subscriptions and holder promotion track demand; eviction releases working-set copies without deleting the database or removing its last required durable copy.

Artifact addresses remain stable when a file moves between holders. References resolve through authorized discovery rather than semantic file paths. An advertised but unavailable artifact is an acquisition failure, not an empty index or absent object. Locked, corrupt and incomplete artifacts are distinguishable from absence. Reconnection never regenerates lost content silently.

## Responsibility boundaries

Placement identifies where values are available, not which objects match a query. Indexes identify candidates; data artifacts contain complete values; replication conveys mutations. Local inventory ownership, exact holder/revision schema, subscription lifetime, eviction and restart policy are explicit integration parameters. See [replication.md](replication.md), [data.md](data.md) and [persistence.md](persistence.md).
