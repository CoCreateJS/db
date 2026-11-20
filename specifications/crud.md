# CRUD

## Current request contract

`send(request)` accepts `<scope>.<create|read|update|delete>`. The scope must be configured. The target property accepts one object or an array. Ancestor references are supplied by envelope names, including dynamic scope properties. A UUID can bypass named resolution while respecting supplied constraints. Object `_id` and other scope `name` are scoped identities.

Responses preserve envelope properties and return `success` plus an array under the target scope. Failures include `error` messages. No transactional rollback is promised for a multi-object request.

- Create: returns created artifacts; filters are rejected. Missing named ancestors may be created.
- Read: returns local matching artifacts; missing targets may return an empty successful array.
- Update: accepts direct patch fields and `$update` patches at envelope and item level. Item `$update` overrides envelope `$update`, which overrides direct patch fields. Returns applied patch with identity and `updated` snapshots for existing targets. A single-input upsert may create a missing target and return that artifact instead. A missing explicit target without a filter or upsert fails.
- Delete: returns removed artifacts. Missing matches can yield an empty successful array; structural artifacts with children cannot be removed.

Filters use `filter.query`, `startingIndex` (or `index`) and `limit` (default 50; 0 means all). Explicit identities and filter matches are combined. Current implementation rejects nonempty sort and search. `filter.isFilter === false` disables filter use. Operator support depends on shared utilities and validated artifact values, not blanket MongoDB compatibility.

## External workflows

CRUD calls DB then a configurable workflow. Local misses, remote lookup, persistence acquisition, authorization, durability and communication are external concerns. A local empty result is not proof of global absence. Remote create/update/delete routing requires explicit execution ownership; do not blindly race mutations across nodes. See [mutations](mutations.md) and [distribution](distribution.md).
