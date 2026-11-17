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
carries `organizationId` as its immutable top-level namespace scope. That
namespace is part of the address but is not a CRUD method prefix. Scope routing
and hierarchy are defined in [scopes.md](scopes.md). Object CRUD resolves one storage, database and array scope per request. A `key` is addressed as data within an object, not as a separate CRUD method prefix.

## Common request and response conventions

- Requests identify the target scope and use the `<scope>.<operation>` method.
- Successful responses use a property named for the target scope, such as
  `object`, `array`, or `database`.
- Object mutation responses return the resulting document and its `$update` object
  to clients. Reads return document state without an update object.
- Failed validation or execution returns `success: false` with error details.
- The scope handler owns scope-specific validation and behavior; the database
  does not reinterpret a request as a different scope operation.
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
values, assigns an object ID when absent, and establishes creation/update audit
metadata. The resulting document is indexed and persisted according to the
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

Read resolves a document identity or query filter, uses indexes to obtain
candidates when possible, loads candidate objects, and verifies predicates using
the shared query operators. It then applies requested sorting, search,
pagination, and projection and returns the resulting documents as soon as the
requested values are available. Index planning
must preserve the operator results described in [indexes.md](indexes.md).

### Scope and index read

Scope reads resolve records at the requested scope and may apply read filters.
Index reads return entries for the requested field key. Reads do not mutate state
and produce no mutation update object.

## Update

### Object update and upsert

Update applies only to an existing matching document. With `upsert: true`, it
creates a missing document or updates an existing one. A supplied `$update`
object is reused; otherwise the update object is generated from the request
fields/operators while preserving operation intent. Operators apply to the
state selected by reconciliation. Object identity and creation metadata remain
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

Object delete removes matching documents when reconciliation accepts the
deletion. Scope delete removes the named scope record and its owned resources
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

Every operation selects an authorized tenancy through top-level `organizationId` alongside the child scope properties. The value is never derived from the application object. Object `_id` and artifact UUID are distinct; ordinary updates preserve both. Requests cannot alter ownership or immutable creation metadata. Scope deletion respects reachability and must not leave orphaned owned resources or delete unrelated scopes.

## Operator and response boundaries

The shared Utils contract is authoritative for supported operator names, operand semantics and extended-value handling. Executable predicates such as `$where` require explicit authorization and execution policy; a serialized value is not permission to execute code. No-match updates without upsert never create objects. The exact no-match response shape, uniqueness rules, per-scope authorization and non-object lifecycle details require an explicit public contract; no success shape or cascade guarantee is inferred here.
