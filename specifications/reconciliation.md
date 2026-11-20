# Reconciliation

## Status

This is a planned contract, not current engine functionality. Local CRUD presently applies updates in arrival order without distributed timestamp reconciliation.

## Requirements

Retain original mutation identity and timestamps. Newer conflicting changes should take precedence, preserving compatible independent changes. Equal timestamps require a stable tie-breaker. Document-level audit timestamps alone cannot establish per-key precedence. Relative operators such as increments require deduplication; simply replaying a mutation is not safe.

Define lifecycle conflict behavior (delete versus delayed update, competing create, upsert, tombstones), ordering and recovery before claiming convergence. A filtered mutation on one node may not be appropriate on another. Reconciliation must not fabricate a new logical operation or publish rejected changes. Authorization and routing are external; accepted mutation application belongs to the engine. Persistence must independently prevent stale writes. Exact metadata format and clock policy remain open.
