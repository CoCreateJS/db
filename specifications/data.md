# CoCreateDB Data Specification

## Scope

This specification defines the role of the `data/` artifact group. The complete
storage map is in [architecture.md](architecture.md); logical addressing is in
[scopes.md](scopes.md). Persistence workflows decide the physical backend and
mapping for these artifacts.

## Role of `data/`

`data/` names the group of persisted data artifacts: the actual values belonging
to CoCreateDB scopes. It is separate from `indexes/`, which contains lookup
structures, and `distribution/`, which records where artifacts are held. The
name identifies an artifact role/address; it does not require a physical
directory named `data/` in every provider.

For a filesystem persistence workflow, the intended organization-level layout
may be represented as:

```text
<workflow-base>/<organization_id>/
  data/
    <storage>/<database>/<array>/...
```

The persistence workflow maps these logical artifact paths to its configured
provider. It may store them in local files, cloud object stores, or other
destinations. The precise encoding and filenames are subject to the storage
layout migration task. The logical path remains
`organization namespace → storage → database → array → object → key` regardless
of encoding.

## Stored values

- An object represents a document's key-value data.
- Values retain their supplied JSON-compatible representation; indexing does
  not normalize or rewrite document values.
- Nested object keys remain part of the object value. Indexing nested paths is a
  separate projection described in [indexes.md](indexes.md).
- Object identity and scope addressing determine which document an artifact
  represents; physical file IDs are storage details.
- Index metadata, holder maps, and query-only projections are not document data.

## Boundaries

Mutation behavior that changes stored objects is specified in
[mutations.md](mutations.md). Durable authority, local cache, deletion, and
restart behavior are specified in [persistence.md](persistence.md). This file
does not define a second mutation or persistence policy.
