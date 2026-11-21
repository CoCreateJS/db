# CRUD

## Current request contract

`send(request)` accepts `<root>.<create|read|update|delete>`. The root must be configured. The target property accepts one object or an array. Ancestor references are supplied by envelope names, including dynamic root properties. A UUID can bypass named resolution while respecting supplied constraints. Object `_id` and other root `name` are name identities.

Responses preserve envelope properties and return `success` plus an array under the target root. Failures include `error` messages. No transactional rollback is promised for a multi-object request.

- Create: returns created leaves; filters are rejected. Missing named ancestors may be created.
- Read: returns local matching leaves; missing targets may return an empty successful array.
- Update: accepts direct patch fields and `$update` patches at envelope and item level. Item `$update` overrides envelope `$update`, which overrides direct patch fields. Returns complete resulting snapshots under the target root and accepted mutations with identity under `$update`. A top-level `$update` array replays explicit UUID mutations instead of accompanying snapshots; replay rejects filters and upsert. A single-input upsert may create a missing target and return that leaf instead. A missing explicit target without a filter or upsert fails.
- Delete: returns removed leaves. Missing matches can yield an empty successful array; structural leaves with children cannot be removed.

Filters use `filter.query`, `startingIndex` (or `index`) and `limit` (default 50; 0 means all). Explicit identities and filter matches are combined. Current implementation rejects nonempty sort and search. `filter.isFilter === false` disables filter use. Operator support depends on shared utilities and validated leaf values, not blanket MongoDB compatibility.

## External workflows

CRUD calls DB then a configurable workflow. Local misses, remote lookup, persistence acquisition, authorization, durability and communication are external concerns. A local empty result is not proof of global absence. Remote create/update/delete routing requires explicit execution ownership; do not blindly race mutations across nodes. See [mutations](mutations.md) and [distribution](distribution.md).
