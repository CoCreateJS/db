# Reconciliation

## Phase 1 — object-level precedence

CRUD normalizes an incoming patch and compares its supplied `updated.on` with the resident object's audit timestamp. Numeric timestamps and parseable date strings are supported. If either timestamp is missing, or the incoming timestamp is newer, normal update semantics apply. An older or equal timestamp preserves resident values and audit metadata; only missing, non-positional assignment paths in plain objects may be added. Arrays are treated as whole values for this purpose. Older relative, deletion and rename operators are suppressed conservatively.

`@cocreate/utils` owns this shared update lifecycle through `applyUpdate()`, using `createUpdate()` for operator application and `createUpdateChanges()` / `mergeUpdateChanges()` for resolved changes and consolidation. DB supplies its Tree-aware `updateLeaf()` apply handler, then adds UUID and `_id` to the accepted mutation. The normal timestamp path applies directly to the live object; the older/equal path uses a clone to identify missing assignments before applying the resolved changes to the live leaf.

The response `object` (or configured target root) contains complete independent resulting snapshots. `$update` contains accepted mutations keyed by UUID; fully suppressed mutations are omitted. For an accepted older assignment, the mutation retains its original `updated.on` and supplied `updated.by` for downstream precedence checks, even though the resident audit remains unchanged. A replay with a top-level `$update` array uses those explicit UUID mutations rather than the accompanying snapshots; filters and upsert are not supported in this replay mode. Persistence and delivery remain external.

## Limits and future requirements

Object timestamps do not establish per-key history. This phase can restore a deliberately deleted key, suppress an independent change to an existing key, and yield different results on different peers. Equal timestamps favor the resident value rather than providing a globally deterministic tie-breaker. Older relative operations may be lost; repeated undated relative operations may apply more than once. Mutation identity, per-path precedence, deduplication, tombstones, lifecycle conflicts, clock policy and recovery remain future requirements. A locally filtered mutation is not a substitute for the original event when other peers need different conflict decisions. Do not claim convergence or exactly-once delivery. Persistence adapters own revision capture and cross-instance stale-write prevention.
