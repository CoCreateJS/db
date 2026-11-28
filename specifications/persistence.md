# Storage adapter contract

Disk and Persistence are independent Tree resources. A DB-compatible adapter
exposes both `execute(request)` and `queue`. Assign them through DB initialization
or directly to `tree.disk` and `tree.persistence`. There is no built-in external
Persistence provider or Workflow dependency.

## Requests

After indexing, DB sends the same serialized changes to both resources, without
waiting for one before invoking the other:

```js
{
    operation: 'write',       // write, delete, read, has, or cancel
    kind: 'leaf',             // leaf, branch, config, or roots
    primary: primaryUuid,
    uuid: leafUuid,
    organization_id,
    path: relativeFilePath,
    data: serializedFile     // present on writes
}
```

`primary` groups one Tree's work. Organization root configuration uses the
organization ID as its group. DB supplies relative paths; an external provider
may choose its own mapping. Leaf bytes encode `{ object: leaf }`; branch and
configuration bytes encode their stored structures. Adapters must not mutate
shared requests. A request already handed to an adapter contains the serialized
version accepted at that handoff, independent of later in-memory mutations.

`execute` returns a promise. Adapters own scheduling, grouping, coalescing and
storage. Disk does not notify Persistence. Persistence can proceed independently
or choose its own dependencies. Missing local files can fall back to Persistence;
its existing leaf-read contract returns the document object or `undefined`.
External leaf hydration caches to Disk without echoing the acquired data back
to Persistence. `tree.persist()` delegates to an optional adapter `persist()`.

## Queue and completion

```js
adapter.queue[primaryUuid] = {
    leaves: { [leafUuid]: request },
    branches: { [branchUuid]: request },
    files: { [configUuid]: request }
}
```

The map is adapter-owned and read-only to consumers. It covers pending and
in-flight work. A resource entry shows the latest request; an older in-flight
request retains its own data and may still complete. Each group exposes a
non-enumerable `size` counting resource entries. A group disappears only when
its work completes. Failed writes reject their promises and remain visible;
there is no automatic recovery/retry layer.

DB checks both adapter maps, active operations, indexing and outstanding request
completions before harvesting a Tree. It retains promises for shutdown/completion,
not another storage queue. Absent resources expose an empty queue and complete
no-op requests without activating any queue.

`cancel` removes pending work, not stored files. The normal writer continues
requests it has already taken. Disk returns `{ cancelled, inFlight }`; a cancelled
pending request completes with `{ cancelled: true }`, and a replaced pending
request with `{ superseded: true }`. `delete` is the operation that removes a
stored file. Adapters must provide equivalent cancellation semantics.

Origin-based ownership decisions and automatic cancellation during reconciliation
are separate work; introducing this interface does not elect a writer.
