# CoCreateDB source architecture

The source tree is organized around the active implementation. `src/index.js`
is the single package entry point and composition root. It resolves explicit or
stored configuration, initializes Tree, and wires the Query Planner, CRUD,
Persistence, and disk resources. `Index.send()` delegates to CRUD; Index does
not contain query planning or operation logic.

`Tree.disk` and `Tree.persist` are replaceable asynchronous envelope hooks.
Disk requests use `method: 'disk.*'` with a `disk` payload containing a kind
(`config`, `branch`, or `leaf`), UUID where applicable, and content for writes.
`createStorageDisk()` adapts a storage provider to that contract, while
`createPlatformDisk()` dynamically loads the server or client disk adapter.
Node filesystem APIs are confined to `disk/server.js`; browser OPFS APIs are
confined to `disk/client.js`. Tree awaits hydration and write responses.
Persistence staging uses `method: 'persistence.stage'` with the root UUID,
leaf UUID, and latest operation. The Persistence resource groups those entries;
`Index.persist()` triggers provider dispatch through its replaceable `send`
callback. Staging and external dispatch are separate steps.

Index also binds primary-server telemetry to the Tree's residency controls. The
first valid sample establishes used-memory baseline; the default budget is 25%
of system memory capped by memory available at that baseline. Each newly crossed
internal pressure stage queues one `Tree.shed()` call. A shed flushes pending
index work and evicts one complete lowest-weight group from both resident
branches and leaves. At 90% of budget, Index temporarily enables Tree's
disk-first request path; it clears below the hysteresis point. This is a runtime
pressure override and does not rewrite the configured database mode.

## Tree and CRUD boundaries

`tree/` owns root configuration, live leaves, field/type indexes, branch
splitting and range traversal. It accepts an injected local storage adapter,
so the tree itself does not import Node or browser APIs. `Tree.getRootBranch()`
exposes the top-level field/type index summaries; with an envelope and target
root it also resolves that root's parent and configuration path. Consumers
choose which index to use, request a branch or range, and stream matching
leaves without forcing the Tree to choose a query plan or materialize results.

`Tree.visitRange(key, type, range, visitor, { mutating: true })` keeps a
single range traversal open while the visitor checks the full query and applies
the requested CRUD operation. Returning `Tree.stop` ends that traversal. Tree
defers index reconciliation until the visitor finishes, so an update or delete
cannot shift the active range underneath the loop.

When local storage is enabled, pass an asynchronous `disk` envelope callback
or let the package entry compose the platform adapter. This is the only
platform-specific boundary; Tree itself remains platform neutral.

`Tree.flushLocal()` completes pending index work before writing dirty leaves,
branches and the index catalog. External persistence is outside this Tree
contract. `crud/` and `query-planner/` are independent resources composed by
Index. The planner chooses one index or a full scan, and CRUD verifies the
complete query and applies its operation in the Tree visitor. Index passes the
resolved config to Tree, then injects Tree and the planner into CRUD. CRUD
depends on their APIs rather than importing their implementations; none of
these modules import Index or depend on its setup details.

For indexed reads or mutations, CRUD resolves the request root, asks the
planner for an ordered set of branch ranges, and sends those ranges to one
Tree traversal. The visitor checks the complete Utils predicate and applies
read/update/delete for that leaf before continuing. UUID requests use the same
`find` entry point with a direct Tree lookup. A create without a supplied UUID
skips `find` and inserts directly into the configured root.
