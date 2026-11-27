# Roots and configuration

An organization owns its root schema and structural identities. Organization ID
is an outer scope, not a configured root. The default schema is:

```js
{ storage: { database: { array: { object: {}, index: {} } } } }
```

`organization.roots.get(path)` reads a snapshot. `organization.roots.execute({
operation: 'set', path, data })` modifies definitions using dot notation and saves
the organization's configuration. Existing resident engines receive their local
row definitions. Occupied root definitions cannot be removed or change structural
status. Undefined removes a key through shared Utils dot-notation semantics.

A `$`-prefixed root resolves its name from the corresponding envelope property.
A string or `{ name }` identifies a named ancestor; `{ uuid }` addresses it directly.
A structural leaf has configured children. The organization catalog stores
`config.leaves[uuid] = { root, parent, name }`; a parentless leaf omits parent.
Ordinary application leaves are not catalogued. `config.top` maps parentless row
categories to their primary table UUIDs.

Root discovery uses only this metadata. Named create/upsert requests can establish
missing ancestors, but reads never create them. Unknown UUID ancestors cannot be
invented. Ambiguous configured paths fail. Supplied ancestry constraints still
apply to direct UUID lookup. Structural rename and reparent are unsupported;
structural deletion with children is rejected.

`organization.getTree(primaryUuid)` creates or returns only the requested engine.
Its config contains local row definitions, parent UUID, sizes, and field/type index
catalog. Organization roots/configuration do not live on Tree. A config snapshot
can carry structural addressing to another composer; it does not contain ordinary
payloads or restore data by itself. Consistent identity provisioning across nodes
and storage/provider coordination remain external integration work.
