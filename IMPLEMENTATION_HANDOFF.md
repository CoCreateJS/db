# CoCreateDB implementation handoff

This note captures the active refactor discussion and checkout state for the next
implementation session. The working tree is intentionally uncommitted.

## Agreed direction

- Keep the existing top-level request field `organization_id`; it supersedes the
  `organizationId` spelling in `NEXT_TASK.md` and the specifications.
- Physical artifacts use CoCreate Utils UUIDs. Logical object `_id` remains
  separate from physical UUID identity.
- Each organization has an in-memory root object. `getOrganization(id)` returns
  it and creates an empty root when absent. `setOrganization(id, root)` installs
  the object supplied by persistence/bootstrap. “index JSON” names the root's
  portable/on-disk representation; DB get/set itself is in-memory.
- CRUD may initialize an organization lazily. Persistence may restore/set an
  existing root and owns durable loading/saving. Current disk operations should
  move behind persistence; DB core should not directly decide storage location.
- Store complete application objects as the value source. Indexes refer to
  complete object UUIDs and index nested paths. Keys describe paths; do not
  create separate scalar or terminal-array key payloads in the target layout.
- Target organization layout from `NEXT_TASK.md`: external `index.json`,
  `data/<uuid>` artifacts (no extension or semantic directory), and separate
  local `distribution/`. Use one decoded organization-scoped Map keyed by UUID.
- The DB consumes already prepared/encrypted values as ordinary runtime values;
  do not add a DB codec/encryption layer in this phase. Persistence boundaries
  can later host workflows.
- A request completes once its operation is applied in memory. Distribution is
  the next high-priority effect; indexing and persistence continue afterward.
  Their failures must not rewrite a completed response.
- Replicate update objects/patches, preserving relative operators such as
  `$inc`. Clients receive the resulting object plus its update; peers receive the
  update and needed identity/timestamp metadata.
- Use dot paths for deep indexing, including arrays as an initial direction.
  Array element correlation and nested-array details remain a follow-up contract.
- The agreed timestamp direction is to protect newer document state while
  merging older changes. Exact handling of independent field changes and clock
  ties remains open; isolate this policy rather than inventing a global rule.

## Work completed in the current checkout

- Added `src/organization.js` with in-memory root get/set/delete and
  organization-scoped UUID artifact Map get/set/delete/has operations.
- Exported those functions from `src/index.js`.
- Changed `src/files.js` new physical ID generation to CoCreate Utils `uuid()`
  (UUIDv7, with hyphens removed to fit current 32-hex addressing).
- Added `persistence.send()` to the local write-behind persistence instance for
  `persistence.create/read/update/delete` UUID artifacts and
  `organization.get/set/read/write` root operations. The filesystem layout for
  this new API is `<directory>/<organization_id>/data/<uuid>` with
  `<directory>/<organization_id>/index.json` as the root representation.
- Exposed that sender as `db.persistence.send()` on scoped DB instances when
  disk is enabled.
- Connected scoped organization initialization to read an existing root through
  `persistence.send({ method: 'organization.read', organization_id })` and then
  install it in memory. Exposed `db.organization.get/set/delete`.
- Replaced scoped `root.json` bootstrap with a versioned in-memory root object
  `{ version: '1.0.0', root: '<32-hex UUID>' }`. That root UUID is now the ID of
  the top storage catalog. Root snapshots travel through the persistence
  `organization.read/write` methods.
- Added optional artifact callbacks to the recursive index engine. Scoped
  organization index nodes now read/write/delete by UUID through the decoded
  artifact Map and local persistence sender; standalone `createIndex()` retains
  its filesystem path behavior.
- Changed `recordPath()` so storage, database, array, and object records share
  `data/<uuid>` without extensions. Existing `keys/<uuid>.json` lookups remain
  unchanged while terminal-array values still use separate key records.
- Routed UUID-addressed CRUD reads/writes/deletes through the organization
  artifact Map and persistence sender. Scoped DBs now use write-behind whenever
  disk is enabled; memory-only mode stays in memory.
- Scoped terminal-array index reads now resolve the array value from its owning
  full document. New scoped operations no longer write separate key files, and
  peer key lookups carry the owner UUID and path so the receiver can derive the
  value from its document. Standalone index compatibility remains.
- Syntax and `git diff --check` were inspected. No test suite was run.

This persistence API is an initial adapter path. Terminal-array key records and
deletion tombstones still use their prior storage paths. Legacy terminal-array
key files remain readable; standalone indexes retain key files for compatibility.
The local sender is created by each scoped DB unless disk is disabled.
Remote partition addresses remain `indexes/<uuid>.json`; the local index
artifact adapter maps those node IDs to UUID data artifacts. Legacy `root.json`
datasets are refused when no new root snapshot is restored.

## Recommended next implementation steps

1. Decide and implement nested object indexing inside arrays. Current indexes
   treat arrays as terminal values; path syntax and matching-element correlation
   need a contract before changing that behavior.
2. Rework deep object/array path extraction using CoCreate Utils helpers where
   their semantics fit. Inspect `objectToDotNotation`, `dotNotationToObject`,
   and `getValueFromObject` before relying on them: array paths use bracket
   notation in one helper, and `getValueFromObject` has falsy-value traversal
   behavior that may not fit database reads as-is.
3. Align distribution acquisition/replication with opaque artifact UUIDs and
   the flat layout. Keep local and remote peer inventories separate; do not
   persist remote peer state.
4. Reconcile legacy write-behind tests with the agreed response-first and new
   persistence contracts. Preserve meaningful checks and document intentionally
   unsupported behavior.

## Current status and boundaries

- Repository: `/home/ubuntu/Dev/CoCreateJS/modules/db`, branch `dev`.
- Modified: `README.md`, `src/files.js`, `src/index.js`, `src/index/index.js`,
  `src/io.js`, `src/object/index.js`, `src/persistence.js`,
  `src/persistence/index.js`, `src/root.js`, `src/scoped.js`, and `src/storage.js`;
  untracked: `src/organization.js` and this handoff document.
- Nothing has been committed or pushed for this implementation work.
- Existing `NEXT_TASK.md` and specifications are design inputs, but the user's
  decisions above supersede conflicting details, especially `organizationId`,
  required manifest-on-every-CRUD wording, and separately persisted `keys/`.
- Preserve unrelated local changes. Do not update live CoCreateDB data as part
  of this source refactor.
