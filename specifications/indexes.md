# CoCreateDB Indexing Specification

## Scope

The independently accessible indexing primitive maintains recursive ordered indexes and supports candidate selection without requiring CRUD, Mesh or a particular storage provider. Indexes and catalogs are independently addressable data artifacts as defined in [data.md](data.md).

## Schemaless deep indexing

One logical index exists per indexed key path, independent of value type. Values are preserved without coercion, including mixed types within one index. Missing keys have no value entry; explicit undefined is distinct from absence and requires defined query/index semantics. Deep object and array traversal supports dot paths, array membership and nested array objects. Path escaping, duplicate membership and positional correlation follow the applicable path/operator contract. Binary values are atomic unless explicitly supported otherwise.

Object property paths are entries in the owning array's object index. Every
entry points to the UUID of its complete owning document; property values do
not receive independent artifacts. Equal values use a stable logical identity
or artifact UUID tie-breaker; repeated artifact UUIDs are deduplicated before
returning values. Paths use JavaScript dot properties and zero-based numeric
bracket positions, such as `products[0].price`.

The index records container paths (`object`, `array`, and empty containers) as
well as their children. Every existing array position has an entry, including
explicit `undefined`, `null`, and nested containers. Missing positions end
positional traversal. Sparse arrays are made continuous before indexing.
Container index entries store a digest and recover their value from the owning
document UUID; they do not create sidecar key artifacts.

## Recursive ordered structure

An index-tree root node leads to ordered child segments. This term refers to the
top node within one ordered index and is unrelated to the external bootstrap
configuration's `root` pointer. Each child records its actual first and last
entries and length/count, with the count unit explicitly defined for the index
contract. Parent summaries reflect the current children. Ordering is determined
by entries, not filenames or UUID sequence. The tree uses a deterministic total
order for supported mixed values, including explicit handling of incomparable
values. That order is distinct from operator semantics and cannot justify unsafe
pruning.

Segments split according to actual encoded byte size. A split retains an existing address for one portion and allocates required sibling/root addresses; any changed parent references and summaries are updated coherently. Unsplittable large entries are handled explicitly rather than silently dropped. Deletion prunes empty branches and collapses roots where applicable. Forward and reverse traversal support lazy acquisition of only required segments.

## Query planning

The planner uses counts, boundaries and available indexes to reduce work. For conjunctions it can start with the smallest relevant candidate set; disjunctions combine the required branches. It preserves `_id` enumeration and falls back to scans where an index cannot provide a complete candidate set. Final predicates are evaluated against complete current objects using shared Utils operators. Independent matches on array elements do not establish same-element correlation.

Equality and relational behavior are those of the shared operator, not the tree comparator. Numeric strings, numbers, NaN, null, undefined, arrays, composites and binary values cannot be silently omitted because a range is difficult to order. When pruning cannot be proven safe, broaden the scan. Sorting uses the documented sort contract; pagination and projection operate on the correct matching result set. UTC ISO date strings retain their supplied form; only consistently formatted UTC strings have the expected lexical chronological ordering.

## Pending maintenance

Index maintenance may follow the client response. Queries reconcile relevant pending additions and changes into candidate sets, exclude deleted objects and verify current values. Verifying only stale candidates is insufficient because it cannot recover omitted matches. Version/generation checks prevent delayed maintenance from overwriting newer state. Index acquisition failures propagate as incomplete results/errors rather than empty branches.

## Conformance invariants

- Every index reference resolves within its organization to the appropriate complete object or child artifact.
- Parent bounds and counts agree with child contents after maintenance.
- Query results agree with a reference scan under shared operators, including mixed values and correlated arrays.
- Split, prune, restart and reverse traversal preserve identity and ordering.
- Pending maintenance and partial availability never silently produce false negatives.

Exact comparator, count units, composite/binary indexing and path correlation representations are separate contract parameters; no alternative operator semantics are implied here.
