# CoCreateDB specifications

These documents describe the staged engine contract and external integration requirements. **Current** means implemented in this checkpoint; **planned** means a requirement, not a shipped capability. Illustrative code does not establish additional APIs.

- [Architecture](architecture.md): engine and integration boundaries.
- [Scopes](scopes.md): generic hierarchy, configuration and structural identity.
- [Data](data.md): living artifacts and identity.
- [Indexes](indexes.md): runtime trees and selection.
- [CRUD](crud.md): envelopes and operations.
- [Mutations](mutations.md): application and update responses.
- [Reconciliation](reconciliation.md): planned conflict handling.
- [Replication](replication.md): external mutation delivery.
- [Distribution](distribution.md): acquisition and awareness.
- [Persistence](persistence.md): external workflow orchestration.
- [Edge cases](edge-cases.md): conformance and outstanding requirements.

The [project README](../README.md) describes usage and benchmarks. There is no mandatory index.json, durable root pointer, organization-specific engine, distribution inventory or persistence hook. Structural configuration and ordinary data are separate. Runtime trees are derived from living artifacts.
