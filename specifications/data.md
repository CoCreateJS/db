# CoCreateDB Data Specification

## Data ownership

Artifacts are logical UUID-addressed values held decoded in the DB's in-memory
working set. They include complete application objects, scope catalogs, index
roots and segments, and reconciliation metadata. Persistence owns durable
representation and transfer; the DB core does not own a `data/` directory or
select a provider. Bootstrap input and runtime distribution state are separate
from scope artifacts.

## Artifact addressing

Each artifact has an opaque UUID. UUID is the logical address, not a required
filename; persistence chooses its physical name and representation. An artifact
contains the actual stored value for the scope it represents; indexes resolve
scope addresses to artifact UUIDs. Index structures are also artifacts, but
contain index data rather than application scope values. UUIDs are unique
within the organization boundary; collisions cannot overwrite unrelated
artifacts. Ordinary updates preserve UUID identity. New artifacts, including
new index segments, receive new addresses. A deleted address is not reused for
unrelated data.

Every object document has a top-level, DB-owned `uuid` property matching its
artifact address. It is included in returned and persisted document values,
immutable after creation, and excluded from ordinary field indexing. Object
CRUD can use it to address a document directly. The logical `_id` remains a
separate document field for compatibility and application-level identity;
indexes may resolve it to the UUID. Relocation to another holder does not
change the UUID.

## Complete objects

One application object occupies one artifact, including nested objects, arrays
and supported binary values. A `document` is the complete value at the `object`
scope. Property paths describe values within the document and always resolve to
the owning document artifact. They are represented in the object index rather
than as separate artifacts. For example:

```js
{
    _id: "logical-id",
    settings: { appearance: { theme: "dark" } },
    permissions: ["read", "write"]
}
```

The `object` scope is stored as a complete document artifact, including nested
objects and arrays. Its logical `_id` is distinct from the artifact UUID. Reads
acquire the addressed artifact, verify predicates and apply projection in
memory. Updates apply shared operators to logical paths and persist the resulting
scope value while preserving its artifact identity. Property paths index into
that document and never own separate artifacts.

## Unified values

Runtime values remain decoded JavaScript values. The shared serialization contract preserves nested objects/arrays, strings, booleans, null, explicit undefined distinct from missing, finite and non-finite numbers including NaN and infinities, and native binary bytes. Unsupported values are rejected explicitly. Binary values are atomic for traversal unless an explicit operator contract provides otherwise. Encoding does not execute content or infer schemas. See [persistence.md](persistence.md).

When an object artifact contains CoSON binary descriptors, its `binary` array
is transport metadata owned by that object. References use local `binary[0]`,
`binary[1]` positions and are not indexed as application fields. The metadata is
persisted with the CoSON object frame and restored on read; ordinary user data
named `binary` remains indexable.

## Decoded working set

One organization-scoped `data` Map holds decoded artifacts keyed by exact UUID.
Existence checks distinguish an explicitly stored undefined from absence
(`Map.has`). Multiple organizations can have separate Maps in a registry.
Acquisition is lazy, and caching does not create a duplicate authoritative
object model. Index artifacts contain lookup structures, not alternative
scope-value artifacts. Eviction removes a working-set copy; deletion changes
durable database state.

## Lifecycle

Accepted mutations produce stable resulting values for persistence. Deletion removes the object and relevant index entries while retaining required ordering metadata as data artifacts. Publication, retries and recovery follow [persistence.md](persistence.md); placement and retrieval follow [distribution.md](distribution.md).
