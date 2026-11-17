# CoCreateDB Scope Specification

## Scope hierarchy

Every operation carries a required, caller-supplied `organizationId` as a top-level payload property. It is immutable for the operation, selects tenancy per request, and is separate from application object content and instance configuration.

```text
organizationId → storage → database → array → object → key
```

Illustrative object creation payload:

```js
{
    method: "object.create",
    organizationId: "organization-a",
    storage: "production",
    database: "application",
    array: "users",
    object: { name: "Example" }
}
```

The method selects a child scope and operation; organization is not a CRUD method prefix. A key is a logical path within an object, not a separate CRUD target. Each child scope is resolved through its parent using catalog/index references. Identical logical names in different parent scopes do not identify the same record.

## Tenancy isolation

The authorized organization context is validated before bootstrap resolution or artifact acquisition. A payload ID is an address, not proof of authorization. All cache entries, pending work, subscriptions, provider operations and peer messages preserve organization context. UUID lookup alone cannot cross a tenancy boundary, even if two namespaces contain the same UUID. The organization ID is not generated from a filesystem path or rewritten by ordinary CRUD.

## Namespace provisioning

The external bootstrap authority supplies the required `index.json` for the selected organization. New namespace creation is explicit; reopening does not silently initialize a missing namespace. See [README.md](README.md).

## Filesystem workflow

A filesystem workflow resolves its base path relative to the process working directory (CWD), defaulting to CWD when unspecified. `COCREATE_DB_DIRECTORY` belongs to workflow configuration. The workflow does not append an implicit product-name directory.

| Configured base | Organization location |
| --- | --- |
| Unset or `.` | `<cwd>/<organizationId>/` |
| `../` | `<cwd>/../<organizationId>/` |
| `../CoCreateDB` | `<cwd>/../CoCreateDB/<organizationId>/` |
| `../organizations` | `<cwd>/../organizations/<organizationId>/` |
| `../clusterdb` | `<cwd>/../clusterdb/<organizationId>/` |

The canonical data artifact path is `<base>/<organizationId>/data/<uuid>`. The workflow validates path components and prevents traversal or namespace escape. Bootstrap and distribution ownership are separate from durable data persistence; the corresponding integration must know its local location.

## Addressing invariants

Physical addresses use organization context plus opaque UUID. Storage, database, array, object and key names express logical relationships, not physical paths. Provider remapping and artifact relocation do not alter these relationships. See [data.md](data.md) for identity and [crud.md](crud.md) for method routing.
