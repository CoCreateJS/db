# CoCreateDB Scope Specification

## Scope

This specification defines the logical scope path used to address CoCreateDB
data. The overall physical layout is summarized in
[architecture.md](architecture.md); the root entry artifact is defined in
[README.md](README.md).

## Scope path

Every organization-scoped request carries a required, caller-supplied
`organization_id` in its payload. It is the immutable top-level namespace scope
and creates the main entry point for that organization's database tree:

```text
configured base directory → organization_id (namespace scope) → storage → database → array → object → key
```

The namespace scope is separate from the child data-scope path below. It
participates in addressing every child scope, but the CRUD method does not target
it as an `organization.create`, `organization.read`, `organization.update`, or
`organization.delete` operation. The first request that resolves an
organization initializes its namespace root as needed. The organization ID is
not generated from the path; it is supplied by the caller and used as the
namespace directory name.

The child data-scope path, beneath the namespace scope, is:

```text
storage → database → array → object → key
```

Each scope is resolved through its parent scope. `storage`, `database`, `array`,
`object`, and `key` name logical levels in the data model; they do not each
create an independent root of the organization tree.

## Namespace path and filesystem workflow

The organization namespace is the first storage address. CoCreateDB passes the
caller-supplied organization ID through the persistence boundary; it does not
perform direct filesystem path construction or append a product-name directory.
If a local filesystem persistence workflow is configured, its base directory
determines the physical path and follows this convention: relative paths resolve
from the process working directory, and an unspecified path defaults to the
working directory itself.

Examples for a local filesystem workflow, with `<organization_id>` supplied by
the request and `COCREATE_DB_DIRECTORY` unset:

```text
workflow path unset or "."        → <cwd>/<organization_id>/
workflow path "../CoCreateDB"    → <cwd>/../CoCreateDB/<organization_id>/
workflow path "../organizations" → <cwd>/../organizations/<organization_id>/
workflow path "../clusterdb"     → <cwd>/../clusterdb/<organization_id>/
workflow path "../"              → <cwd>/../<organization_id>/
```

The workflow's base path controls placement only. It does not change the logical
namespace identity or add another scope level. The current core `directory` and
`COCREATE_DB_DIRECTORY` handling is legacy behavior to migrate into the
filesystem workflow.

## Scope and artifact distinction

Scopes describe where a value belongs logically. Index nodes, distribution
records, and data files are physical artifacts used to locate, organize, or
persist those values. An artifact's filename or node ID does not change the
logical scope path.

The `data/` representation of scoped records is defined in
[data.md](data.md). The root index and index-node relationship is defined in
[README.md](README.md) and [indexes.md](indexes.md).
