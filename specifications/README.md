# CoCreateDB specifications

These documents describe the staged engine contract and external integration requirements. **Current** means implemented in this checkpoint; **planned** means a requirement, not a shipped capability. Illustrative code does not establish additional APIs.

- [Architecture](architecture.md): engine and integration boundaries.
- [Roots](roots.md): generic hierarchy, configuration and structural identity.
- [Data](data.md): living leaves and identity.
- [Indexes](indexes.md): runtime trees and selection.
- [CRUD](crud.md): envelopes and operations.
- [Mutations](mutations.md): application and update responses.
- [Reconciliation](reconciliation.md): planned conflict handling.
- [Replication](replication.md): external mutation delivery.
- [CRUD awareness](awareness.md): UUID references and recipient routing.
- [Persistence](persistence.md): Tree resource boundary and adapter-owned policy.
- [Edge cases](edge-cases.md): conformance and outstanding requirements.

The [project README](../README.md) describes usage, client/server runtimes and benchmarks. CoCreateDB is the local database engine on both browser clients and Node servers; CoCreate CRUD and communication layers connect instances into distributed applications. Browser storage uses OPFS and disk-first processing. Node server storage uses the filesystem and defaults to adaptive Hot/Warm residency. The DB package does not itself establish client-server connections or replicate changes. Tree exposes an optional Persistence resource; DB assigns it directly and Tree forwards leaf operations to it. Persistence policy belongs to the attached resource. Complete external root/index branch persistence is not implemented; Cold archival storage is a separate integration. There is no mandatory index.json, durable root pointer, organization-specific engine or recipient inventory. Structural configuration and ordinary data are separate. Runtime indexes are derived from living leaves.
