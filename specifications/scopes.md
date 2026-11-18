# CoCreateDB Scope Specification

## Scope hierarchy

Every operation carries a required, caller-supplied `organization_id` as a
top-level payload property. It identifies the organization boundary for that
operation and may represent a company, project, or other grouping. There is no
additional namespace tier above it. It is separate from application object
content and instance configuration.

```text
storage → database → array → object
```

`storage` is the first scope within an organization and groups databases. A
database groups arrays, and an array contains object documents. Property names
and paths belong to the object index; they are not scopes. The organization is identified directly by
`organization_id`; it is not another scope in this chain.

Illustrative object creation payload:

```js
{
    method: "object.create",
    organization_id: "organization-a",
    storage: "production",
    database: "application",
    array: "users",
    object: { name: "Example" }
}
```

The method selects a child scope and operation; `organization_id` is not a
CRUD method prefix. Each scope is resolved through its parent using indexes.
An index resolves to another index or to the UUID artifact holding the
addressed scope value. The `object` scope value is a complete document. Each
object property path is indexed directly against that document artifact; paths
have no independent UUID or artifact. Identical logical
names in different parent scopes do not identify the same record.

## Tenancy isolation

The authorized organization context is validated before bootstrap resolution or artifact acquisition. A payload ID is an address, not proof of authorization. All cache entries, pending work, subscriptions, persistence calls and peer messages preserve organization context. UUID lookup alone cannot cross an organization boundary, even if two organizations contain the same UUID. The organization ID is not generated from a persistence path or rewritten by ordinary CRUD.

## Namespace provisioning

A CRUD request can initialize an organization in memory when it is first used.
Persistence may supply an existing root before normal operations, or receive
the generated root for later recovery. Root creation and installation are
separate from locating a persistence provider; the DB core does not own that
provider choice. See [README.md](README.md).

## Persistence boundary

The DB core is in-memory and does not own a filesystem path or choose where
data comes from or is stored. It requests a value from persistence and uses the
result, or submits a value and expects persistence to save it. The persistence
integration owns provider selection, physical addressing, serialization and
durability. Organization context and artifact UUIDs identify the logical
request; they do not prescribe a path or provider.

## Addressing invariants

Logical addresses use organization context plus opaque UUID. Storage,
database, array and object names express relationships, not persistence
locations. Object property paths are index selectors into their owning object.
Provider remapping and artifact relocation do not alter these
relationships. See [data.md](data.md) for identity and [crud.md](crud.md) for
method routing.
