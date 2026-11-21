# Roots and configuration

## Current model

A root is a leaf category. `parent` is the immediate parent leaf UUID; `name` is a named reference. The default configuration is:

```js
{
    version: '1.0.0',
    roots: { $organization_id: { storage: { database: { array: { object: {}, index: {} } } } } },
    leaves: {}
}
```

Any `$`-prefixed root resolves its name from the corresponding envelope property, not just organization_id. A string reference names a leaf; `{ name }` or `{ uuid }` can also address an ancestor. The name does not become the UUID. A structural root has configured children. Structural identities are recorded as `config.leaves[uuid] = { root, parent, name }` (root omits parent). Application data leaves are not catalogued there.

`config` returns a defensive snapshot with non-enumerable `getValue(path)` and `setValue(path,value)` accessors backed by current configuration. Only root definitions can be edited by setValue on the primary. Occupied definitions cannot be removed or change structural status. Config transfer restores structural identities, not leaf data or arbitrary structural payload fields. No root pointer is required. `init` uses @cocreate/config; explicitly supplied config overrides resolved settings.

Create and upsert can establish missing named ancestors. Read never creates ancestors. Unknown UUID ancestors cannot be invented. Ambiguous paths fail. Direct UUID lookup validates supplied ancestry constraints without resolving named ancestors. Structural rename, reparent and deletion with children are rejected.

## Integration requirements

Authorization is external and must precede DB access. Dynamic roots are addressing, not access control. Consistent structural identity provisioning across nodes and complete hydration remain planned; concurrent creation of competing structural identities requires external coordination or a defined reconciliation policy.
