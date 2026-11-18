# CoCreateDB CRUD Specification

## Scope

This specification describes how CRUD method envelopes select a target scope,
what create/read/update/delete mean at that scope, and where operator behavior
fits. It does not redefine the general state-change rules in
[mutations.md](mutations.md), conflict precedence in
[reconciliation.md](reconciliation.md), index behavior in
[indexes.md](indexes.md), peer messages in [replication.md](replication.md), or
storage lifecycle in [persistence.md](persistence.md).

## Method selects both scope and operation

A CRUD method has the form `<scope>.<operation>`:

| Method prefix | Target scope | Operation suffixes |
|---|---|---|
| `storage` | Storage configuration/record | `create`, `read`, `update`, `delete` |
| `database` | Database scope record | `create`, `read`, `update`, `delete` |
| `array` | Array scope record | `create`, `read`, `update`, `delete` |
| `object` | Document in an array | `create`, `read`, `update`, `delete` |
| `index` | Field-index entries | `create`, `read`, `update`, `delete` |

The method prefix identifies which child data-scope handler receives the
request; the suffix selects the CRUD operation applied there. Every request also
carries `organization_id` as its immutable top-level organization identity.
Scope routing
and hierarchy are defined in [scopes.md](scopes.md). Object CRUD resolves one
storage, database and array scope per request. Object property paths are
handled by the object index and do not have separate CRUD methods or artifacts.

## Common request and response conventions

- Requests identify the target scope and use the `<scope>.<operation>` method.
- Successful responses use a property named for the target scope, such as
  `object`, `array`, or `database`.
- Object mutation responses return the resulting document and its `$update` object
  to clients. Reads return document state without an update object.
- Failed validation or execution returns `success: false` with error details.
- The scope handler owns scope-specific validation and behavior; the database
  does not reinterpret a request as a different scope operation.
- For storage, database, array, and object CRUD, the target property accepts one
  non-null object or an array of such objects. A missing property and an empty
  array select nothing. Strings, primitive values, nested arrays, and arrays of
  strings are invalid; the engine does not convert them to identity objects.
- Once the required data is ready in memory and the CRUD operation has produced
  its result, return immediately. Do not wait for disk persistence, background
  indexing/cleanup, or peer acknowledgments.
- A read may wait for the requested data itself to be loaded or acquired. This is
  separate from waiting for acknowledgments or unrelated backend work.
- A background failure must not retroactively change a response already
  returned; report and recover it through the background work's own mechanism.

## Create

### Object create

Create accepts one object or an array of objects. It preserves supplied field
values, assigns an immutable artifact `uuid`, retains a separate logical
`_id` as the object's secondary identity, and establishes creation/update audit metadata. The
resulting document is indexed and persisted according to the
configured persistence policy after the response boundary. Return the created
document and update information as soon as the result is ready in memory.
Conflict acceptance and ID reuse follow
[reconciliation.md](reconciliation.md).

### Scope and index create

Storage, database, and array creates establish the corresponding named scope
record. Index create inserts supplied index entries. These operations do not
create document mutations unless they target an object document.

## Read

### Object read

`object.uuid` and `object._id` are independent explicit selectors. If both are
provided, they must resolve to the same document. Explicit selection does not
use filter conditions, sorting, pagination, or limits. A filter independently
selects additional documents; the combined result is deduplicated by UUID, with
explicit results first. Ordinary filter reads use indexes to obtain candidates
when possible and verify predicates using shared query operators. Index
planning must preserve the operator results described in [indexes.md](indexes.md).

### Scope and index read

Scope reads resolve records at the requested scope and may apply read filters.
Index reads return entries for the requested property path. Reads do not mutate state
and produce no mutation update object.

## Update

### Object update and upsert

Update applies a supplied `$update` to explicit UUID/`_id` selections and,
independently, to documents selected by a filter. Explicit selections are never
excluded by the filter. A filter-selected update requires one unambiguous update
payload; multiple distinct payloads with a filter are rejected. With
`upsert: true`, a missing explicit target may be created, subject to object
creation rules. The document UUID, logical `_id`, and creation metadata remain
immutable; `updated.on` carries update audit time and the original mutation
timestamp must be preserved when propagated.

The client receives the resulting object and update object. Peers receive the
operation-tagged update object and required addressing/reconciliation metadata,
not the full resulting document, according to [replication.md](replication.md).
Return to the client as soon as the accepted in-memory result is produced;
neither peer acknowledgments nor later persistence gates it.

### Scope and index update

Scope update changes the scope record's supported metadata. Index update changes
the addressed field-index entries. These handlers have their own target shape
and do not use object update operators unless their contract explicitly accepts
them.

## Delete

Object delete combines explicit UUID/`_id` selections with filter-selected
documents independently, deduplicated by UUID. Without either selection, it
deletes nothing. Scope delete removes the selected scope record and its owned resources
according to that scope's lifecycle. Index delete removes matching index
entries. Object deletion returns explicit deletion state and the mutation
update object to the client and propagates the deletion mutation to peers; peer
payload shape is specified in [replication.md](replication.md). Return the
deletion result without waiting for persistence or peer acknowledgments.

## Query and update operators

Query operators apply to values stored in documents. CoCreateDB indexes retain
the field values without schema-based coercion; the query value is compared to
the stored value using the shared operator's semantics. Indexes narrow candidate
sets only when that cannot change the result.

The shared `@cocreate/utils` query contract governs operators such as `$eq`, `$ne`, `$not`, `$lt`,
`$lte`, `$gt`, `$gte`, `$in`, `$nin`, `$all`, `$elemMatch`, `$size`, `$exists`,
`$regex`, `$options`, `$type`, `$mod`, `$where`, `$and`, `$or`, and `$nor`.

Object update modifiers use shared `createUpdate` behavior. The shared operator set
includes `$set`, `$rename`, `$inc`, `$push`, `$each`, `$splice`, `$unset`,
`$delete`, `$slice`, `$pop`, `$shift`, `$addToSet`, and `$pull`. Their operand,
path, array, and validation semantics are owned by the Utils operator contract;
this specification describes how CRUD invokes them, not a second operator
implementation. See [`../utils/README.md`](../utils/README.md) in the sibling
CoCreate modules repository for the shared operator reference.

## Tenancy and identity

Every operation selects an authorized organization through top-level `organization_id` alongside the child scope properties. The value is never derived from the application object. Every entity has an immutable UUID. Storage, database, and array also have a unique `name` within their parent scope; object `_id` is unique within its array. UUID is the primary identity, while name and `_id` are secondary identities. Either can select an entity independently; when both are supplied they must resolve to the same entity. Ordinary updates preserve UUIDs and object `_id`. Requests cannot alter ownership or immutable creation metadata. Scope deletion respects reachability and must not leave orphaned owned resources or delete unrelated scopes.

Storage, database, and array creation require `name`; object creation accepts an
empty object and generates its UUID. Empty creation is not supported for the
other scopes. Duplicate identities fail. Upsert follows the same requirements
as create. Deleting every object leaves its array in place; deleting the array
removes its contents.

## Filter selection

An absent filter selects no additional entities. An empty filter matches all,
subject to the default limit of 50. A positive integer `filter.limit` caps only
filter-selected results; `0` means unlimited and negative or non-integer limits
are invalid. Sorting, search, projection, and pagination apply only to filter
selection. Explicit selections do not consume the filter limit. Results are
deduplicated by UUID without refilling a filter page when it overlaps an
explicit selection. Filters apply to read, update, and delete; create does not
use filters. `deletedOn` remains ordinary application data and does not trigger
deletion.

## Operator and response boundaries

The shared Utils contract is authoritative for supported operator names, operand semantics and extended-value handling. Executable predicates such as `$where` require explicit authorization and execution policy; a serialized value is not permission to execute code. No-match updates without upsert never create objects. The exact no-match response shape, uniqueness rules, per-scope authorization and non-object lifecycle details require an explicit public contract; no success shape or cascade guarantee is inferred here.
