# CRUD

## Current request contract

`send(request)` accepts `<root>.<create|read|update|delete>`. The root must be configured. The target property accepts one object or an array. Ancestor references are supplied by envelope names, including dynamic root properties. A UUID can bypass named resolution while respecting supplied constraints. Object `_id` and other root `name` are name identities.

Responses preserve envelope properties and return `success`, an `awareness` array of UUID references, and an array under the target root. The DB owns reference calculation only; it does not store recipient registrations or deliver messages. Caller-supplied `awareness` is discarded. Failures include `error` messages. No transactional rollback is promised for a multi-object request.

Each returned leaf contributes its UUID. A filtered request also contributes the UUID of the resolved parent branch, including when the filter returns no leaves. This parent is selected by the CRUD root: for example, an object query refers to its containing array, while an array query refers to its containing database. Create, update and delete results contribute the parent branch UUID of each affected leaf so branch-aware recipients can receive mutations. A direct UUID read contributes the leaf UUID without its parent branch. References are deduplicated, and `organization_id` remains a separate top-level scope.

- Create: returns created leaves; filters are rejected. Missing named ancestors may be created.
- Read: returns local matching leaves; missing targets may return an empty successful array.
- Update: accepts direct patch fields and `$update` patches at envelope and item level. Item `$update` overrides envelope `$update`, which overrides direct patch fields. Returns complete resulting snapshots under the target root and accepted mutations with identity under `$update`. A top-level `$update` array replays explicit UUID mutations instead of accompanying snapshots; replay rejects filters and upsert. A single-input upsert may create a missing target and return that leaf instead. A missing explicit target without a filter or upsert fails.
- Delete: returns removed leaves. Missing matches can yield an empty successful array; structural leaves with children cannot be removed.

Filters use `filter.query`, `startingIndex` (or `index`) and `limit` (default 50; 0 means all). Explicit identities and filter matches are combined. `filter.sort` is an ordered array of `{ key, direction }`, with `asc`/`desc` directions. All sort fields participate before pagination; UUID ascending breaks ties. Search uses Utils `searchData` as a document residual. Responses set `filter.startingIndex` to the applied offset and `filter.index` to offset plus the returned count. Indexed selection and pagination apply to filtered reads, updates and deletes. `filter.isFilter === false` disables filter use. Operator support depends on shared utilities and validated leaf values, not blanket MongoDB compatibility.

## External workflows

CRUD calls DB then a configurable workflow. Local misses, remote lookup, persistence acquisition, authorization, durability and communication are external concerns. A local empty result is not proof of global absence. Remote create/update/delete routing requires explicit execution ownership; do not blindly race mutations across nodes. See [mutations](mutations.md) and [awareness](awareness.md).
