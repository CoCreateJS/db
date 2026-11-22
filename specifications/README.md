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
- [Persistence](persistence.md): callback, pending journal and external workflow contract.
- [Edge cases](edge-cases.md): conformance and outstanding requirements.

The [project README](../README.md) describes usage and benchmarks. The local residency policy is Hot memory plus Warm disk; mode defaults to adaptive and acknowledgement defaults to memory. Cool external Persistence has an explicit callback and pending-leaf journal, but complete Persistence Tree and root/index branch durability are not implemented; Cold archival storage is a separate integration. There is no mandatory index.json, durable root pointer, organization-specific engine or recipient inventory. Structural configuration and ordinary data are separate. Runtime indexes are derived from living leaves.
