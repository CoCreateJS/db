# CoCreateDB Indexing Specification

## Scope

This specification defines how CoCreateDB indexes schemaless field values and
uses those indexes to produce query candidates. It defines neither document
mutation semantics nor the broader query API. Document mutations are covered by
[mutations.md](mutations.md); query operators and their public contract should
be documented alongside the query API when specified.

## Schemaless field indexing

- Each indexed field path has one logical index, independent of the values'
  apparent types.
- Store the value supplied in the document. Do not normalize or convert values
  to fit a field schema or a type-specific index.
- A field may contain mixed values. The index preserves those values as they
  occur; applications may intentionally use mixed content.
- Missing values have no index entry. Type predicates such as array, null, or
  boolean checks belong to query operators, not to separate index layouts.
- Nested fields are addressed by their field paths. Nested-object indexing
  configuration, where supported, determines which paths are indexed.

## Ordered index structure

Entries are ordered by indexed value, with a stable tie-breaker such as object
ID for equal values. Index nodes summarize their true first and last entries.
Large indexes split into ordered chunks/nodes; chunk names and IDs do not imply
value order. Parent boundaries describe the actual values in each child.

The index stores values without coercion. Sorting, equality, and range behavior
must match the query operator contract applied to the stored value and supplied
query value. In particular, equality does not make a numeric value equal to the
same digits stored as text unless the selected operator explicitly defines that
behavior.

## Query candidate planning

The index is a candidate-selection structure, not a source of normalized field
values. Query operators determine whether candidates match. The planner may use
ordered boundaries to narrow a candidate set only when doing so preserves the
operator's results. When mixed values or JavaScript relational semantics make a
range unsafe to prune, the planner must scan a broader candidate set and verify
each candidate with the query operator.

Sorting the final query results must use the documented sort contract over the
stored values. The index comparator and query comparator must not silently
disagree in a way that omits valid matches or produces an invalid range plan.
JavaScript relational comparison is not a total ordering for all mixed values;
the implementation must explicitly handle incomparable values and coercion
before using a comparator for tree ordering or range pruning.

## Date values

The database does not infer a schema or convert arbitrary values into dates.
Callers are responsible for supplying dates in the agreed sortable form. The
current project convention is UTC ISO date strings. Indexing preserves the
supplied string; it does not parse or rewrite it. Any guarantee that chronological
order matches lexicographic order depends on the value following that UTC ISO
format.

## Invariants

- One logical index exists per indexed field path, not per field-and-type pair.
- Index entries retain the original values and object identities.
- Chunk boundaries reflect actual sorted entries.
- Query planning may reduce work but must preserve the query operator's results.
- Unsupported or incomparable values must not be silently dropped.

## Open implementation details

The exact total-order comparator for mixed values, behavior for `NaN`, infinities,
undefined and composite values, and planner fallback thresholds need explicit
decisions before mixed-value range pruning can be considered complete. See
[`NEXT_TASK.md`](../NEXT_TASK.md) for current migration and implementation work.
