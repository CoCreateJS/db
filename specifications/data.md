# CoCreateDB Data Specification

## Data ownership

`data/` contains every database-owned durable artifact: complete application objects, scope catalogs, index roots and segments, and durable reconciliation metadata. It is the sole database-managed cloud persistence and portable export boundary. The external bootstrap manifest and local distribution state are not data artifacts.

## Artifact addressing

Each artifact has an opaque randomly generated UUID. The canonical filename is exactly that UUID, without an extension or semantic path. UUIDs are unique within the organization namespace; collisions cannot overwrite unrelated artifacts. Ordinary updates preserve UUID identity. New artifacts, including new index segments, receive new addresses. A deleted address is not reused for unrelated data. The precise UUID textual representation and concurrent creation mapping are governed by the identity contract.

Logical object `_id` identifies an object within its logical scope; the physical UUID identifies its stored artifact. Index/catalog references resolve logical identities to UUIDs. Relocation to another holder does not change those references.

## Complete objects

One application object occupies one artifact, including nested objects, arrays and supported binary values. Keys describe paths in the object rather than separately stored payloads. For example:

```js
{
    _id: "logical-id",
    settings: { appearance: { theme: "dark" } },
    permissions: ["read", "write"]
}
```

Indexes for `settings.appearance.theme` and `permissions` can both reference the same complete object UUID. Reads acquire that object, verify predicates and apply projection in memory. Updates apply shared operators to its logical paths and persist the resulting complete object, not separate terminal key artifacts. A small update to a large object may therefore rewrite the whole artifact.

## Unified values

Runtime values remain decoded JavaScript values. The shared serialization contract preserves nested objects/arrays, strings, booleans, null, explicit undefined distinct from missing, finite and non-finite numbers including NaN and infinities, and native binary bytes. Unsupported values are rejected explicitly. Binary values are atomic for traversal unless an explicit operator contract provides otherwise. Encoding does not execute content or infer schemas. See [persistence.md](persistence.md).

## Decoded working set

One organization-scoped `data` Map holds decoded artifacts keyed by exact UUID. Existence checks distinguish an explicitly stored undefined from absence (`Map.has`). Multiple organizations can have separate Maps in a registry. Acquisition is lazy, and caching does not create a duplicate authoritative object model. Index projections are derived data, not alternative application object storage. Eviction removes a working-set copy; deletion changes durable database state.

## Lifecycle

Accepted mutations produce stable resulting values for persistence. Deletion removes the object and relevant index entries while retaining required ordering metadata as data artifacts. Publication, retries and recovery follow [persistence.md](persistence.md); placement and retrieval follow [distribution.md](distribution.md).
