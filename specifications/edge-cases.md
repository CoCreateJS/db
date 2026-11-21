# Edge cases and conformance

| Scenario | Current behavior or requirement |
| --- | --- |
| Duplicate UUID | Reject unrelated overwrite in one engine; cross-node collision policy planned. |
| Same name under distinct parents | Root name lookup is parent-qualified. |
| Dynamic root | Resolve from envelope without using its value as UUID. |
| Missing named ancestor | Read does not create; create/upsert may create. |
| Invalid or cyclic configuration | Reject malformed hierarchy or unresolved parent catalog. |
| Supplied UUID with mismatched ancestor | No direct match. Authorization remains external. |
| Structural mutation | Reject rename/reparent and deletion with children. |
| Missing local object | Read can return empty; external workflow determines acquisition/completeness. |
| Filtered query with partial coverage | Global merge, sort, pagination and deduplication are planned externally. |
| Unsupported value or update | Validate and reject where unsupported; no universal type fidelity claim. |
| Batch failure | Earlier accepted changes may remain; atomic transactions not implemented. |
| Live object reference | Direct assignment can bypass indexes; use mutation APIs. |
| Concurrent acquisition and mutation | Planned identity/version handling to avoid stale hydration. |
| Duplicate increment or delayed delete | Planned reconciliation and deduplication. |
| Async persistence failure | Workflow owns retry, ordering and acknowledgement policy. |
| Last in-memory copy removed | External retention policy must prevent unintended loss. |
| Recursive route cycles | External bounded route, deadline and correlation required. |

These cases are requirements or observations, not a claim of complete test coverage. See the Node tests in `../test/` and individual owning specifications for details.
