# CoCreateDB Edge Cases

This catalog defines cross-layer required outcomes. Owning specifications establish policy; the scenarios below provide conformance cases rather than a second implementation contract.

| Scenario | Required outcome | Authority |
| --- | --- | --- |
| Same UUID or logical names in two organizations | No cross-tenant cache, discovery, provider or peer access; authorization precedes resolution. | [Scopes](scopes.md) |
| Missing or malformed bootstrap; unavailable first index | Explicit failure; no implicit new namespace or replacement index. | [Bootstrap](README.md) |
| UUID collision or competing create | No unrelated overwrite; logical-to-physical identity follows agreed creation contract. | [Data](data.md), [Reconciliation](reconciliation.md) |
| Mixed types, NaN or incomparable values | Preserve original values; widen candidate scan if bounds are unsafe. | [Indexes](indexes.md) |
| Missing vs explicit undefined | Distinguish existence; do not conflate decoded Map absence or query semantics. | [Data](data.md), [Indexes](indexes.md) |
| Array predicates match different members | Verify correlation against complete object, not independent membership matches. | [Indexes](indexes.md) |
| Binary value appears in nested object | Preserve bytes; do not enumerate bytes as keys or silently JSON-coerce them. | [Data](data.md), [Persistence](persistence.md) |
| Read while indexing is pending | Include pending matches, exclude deletes and verify current state. | [Indexes](indexes.md) |
| Delayed index maintenance or provider write | Version checks prevent stale completion from replacing newer state. | [Indexes](indexes.md), [Persistence](persistence.md) |
| Equal timestamps or independent key changes | Deterministic precedence and sufficient per-change metadata preserve compatible changes. | [Reconciliation](reconciliation.md) |
| Duplicate `$inc` or relative operation | Stable mutation identity prevents repeated application. | [Reconciliation](reconciliation.md) |
| Older upsert after delete or restart | Durable ordering knowledge prevents stale resurrection. | [Reconciliation](reconciliation.md) |
| Relative update arrives without base | Acquire valid base or report failure; never apply to invented empty state. | [Replication](replication.md) |
| Advertised holder is unavailable; artifact moved | Targeted discovery/recovery preserves UUID; incomplete path is not an empty result. | [Distribution](distribution.md) |
| Last subscriber leaves | Eviction is not deletion and preserves required durable copies. | [Distribution](distribution.md) |
| Process fails after response | In-memory acknowledgment is not durability; client copy and workflow replay are independent recovery paths. | [Persistence](persistence.md) |
| Partial provider failure or no workflow | Report independently; no hidden core filesystem fallback. | [Persistence](persistence.md) |
| Interrupted split or bootstrap publication | Recovery respects reachable identities and never silently substitutes lost content. | [Indexes](indexes.md), [Persistence](persistence.md) |
| Encryption key rotation | Versioned references and retained decryption capability protect readable data across rotation. | [Persistence](persistence.md) |
| Unsupported serialized value or hostile bytes | Explicit rejection, bounded decoding and no arbitrary execution. | [Persistence](persistence.md) |
| Scope deletion with shared/reachable artifacts | No orphaned owned resources or deletion of unrelated scopes. | [CRUD](crud.md) |
| Package version differs from manifest | Provenance mismatch alone does not block open; codec compatibility is independent. | [Bootstrap](README.md) |

## Conformance boundary

Tests exercise these scenarios with controlled workflows, peer fixtures, delayed effects and restart conditions. Query correctness is compared against reference scans. Identity, type preservation and namespace isolation are tested independently of provider choice. Where an owning specification delegates exact protocol parameters, conformance requires the agreed parameter contract; the table does not invent guarantees for unspecified durability or convergence semantics.
