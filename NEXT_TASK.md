# CoCreateDB — Next Development Task

> Repository: `CoCreateJS/db`
> Package: `@cocreate/db`
> Product/documentation name: `CoCreateDB`

## Current state

- Filesystem-backed database, array, and object CRUD use the recursive index engine.
- CoCreateDB initializes on the Cluster server instance as `server.db`; CRUD uses that instance after organization and host routing.
- The recursive Distribution Index tracks regular index partition paths and their holder node IDs; partition files can be acquired from peers during traversal and mutations are targeted to current holders.
- Object creates/deletes send full records; updates send `$update` patches and current database/array metadata to known holders. Client update replies contain the result plus the patch. Cross-node operation ordering remains a follow-up discussion.
- A legacy database/array/object availability map still supports exact `_id` metadata/document acquisition during the transition to index-trail data resolution.
- Arrays are terminal index values stored in bounded chunks. Ordinary object paths remain recursively indexed; arrays do not create positional or nested-member index paths.
- Peer fetches are targeted over Cluster's existing mesh, correlated, and time-bounded. The Cluster whitelist/connection path remains the trust boundary.

## Next implementation phases

1. **Initial partition map sync and local reconstruction**
   - Bootstrap a clean node from the first initialized node in Mesh, then apply later partition availability events.
   - Rebuild local holder entries from regular index files after restart; remove stale references for files that no longer exist.
   - Test snapshot import, duplicate holder updates, and reconstruction after restart.

2. **External file storage fallback**
   - Define and implement individual index/document file reads and writes for configured storage adapters.
   - Resolve locally first, then from a peer holder, then from external storage; never persist `distribution/` metadata.
   - Make configured storage the durable source of truth: complete its write before reporting a mutation committed or propagating the change to peers.
   - Define missing/corrupt file behavior, acknowledgements, retry/replay, and last-write-wins conflict metadata.

3. **Terminal array chunk acquisition**
   - Track and resolve the bounded `index/values/` chunks needed to reconstruct terminal array index values on another node.
   - Keep chunks distinct from object documents and preserve the per-file size bound.

4. **Replace legacy entity location lookup**
   - Resolve matching documents by following index partition references to local files or configured storage.
   - Remove the separate object-to-node availability lookup once the replacement path covers metadata and documents.

5. **Optional peer message signing decision**
   - Evaluate request/response signing as defense-in-depth over the existing whitelisted Cluster mesh; signing is not implemented and does not replace the trust boundary.

## Constraints

- Read `AGENTS.md` and `ARCHITECTURE.md` before changing the index engine.
- Keep document identity scoped by `databaseId + arrayId + objectId`.
- Reuse the recursive index, CoCreate CRUD provider registry, and Cluster mesh; do not add a parallel CRUD layer or transport.
- Preserve full objects when materializing; projection only shapes the returned response.
- Preserve terminal array semantics and shared query-utility behavior.
- Keep peer acquisition targeted by partition path and bounded by a timeout.
- Preserve unrelated workspace changes and report consistency limitations accurately.

## Follow-up discussion requested

- Discuss operation ordering after the server `$update` contract is complete.
- Keep IndexedDB generation, optimistic client acknowledgments/rendering, and
  cross-node ordering/conflict policies outside this server patch task.
