# CoCreateDB

CoCreateDB is a JavaScript ESM project for storing CoCreate objects as JSON files and maintaining ordered indexes over their fields. The current filesystem prototype is independently usable and does not require CoCreate Server.

## Filesystem storage and CRUD `send`

Create a local instance by providing its storage root. A fresh root is initialized as requests arrive:

```js
import { createDB } from '@cocreate/db'

const db = createDB({ directory: './example-storage' })

const created = await db.send({
    method: 'object.create',
    organization_id: 'example-org',
    database: 'example-db',
    array: 'users',
    object: {
        name: 'Ada',
        age: 31,
        active: true,
        'profile.city': 'Lima'
    }
})

const result = await db.send({
    method: 'object.read',
    database: 'example-db',
    array: 'users',
    filter: { query: { 'profile.city': 'Lima' } }
})

console.log(created.object[0]._id)
console.log(result.object)
```

Run the checked-in example to populate the ignored `example-storage/` folder with object files, regular indexes, and the local `example-node` partition-holder map:

```sh
npm run example:filesystem
```

The local layout is created on demand:

```text
example-storage/
  databases/
    index/
      index.json
      <catalog-node-id>.json
    <database-id>/
      database.json
      arrays/
        index/
          index.json
          <catalog-node-id>.json
        <array-id>/
          array.json
          index/
            index.json
            <field-index-node-id>.json
          objects/
            <object-id>.json
```

Logical database and array names map to stable 24-character ObjectIds through recursive name indexes; the shared `ObjectId()` utility generates these IDs, while `uuid()` generates 32-character hexadecimal internal index-node IDs. Data directories use those IDs, so renaming a database or array updates its catalog and metadata without moving objects. Database and array metadata JSON can hold configuration such as future encryption settings.

`send()` supports create/read/update/delete for databases and arrays, and object CRUD. Database and array create/delete requests accept one name or a list of names. Update renames one target with `database` or `array` set to the current name and `name` (or `newName`) set to the new name; an optional `config` object is merged into its metadata. Database reads return metadata records in `response.database`; each database includes its `arrayLength`, `objectLength`, and arrays. Array reads return records in `response.array`, with each record carrying its `name`, stable `_id`, total object `length`, and `$database` reference. Array operations require one database name. Object writes can create missing database and array catalog entries implicitly. Deleting an array removes its objects and indexes; deleting a database removes all of its arrays and data.

Read requests use the shared CoCreate filter shape: `filter.query` is evaluated with `queryData`, `filter.search` with `searchData`, `filter.sort` with `sortData`, `filter.key` applies an inclusion/exclusion projection, and `filter.limit` plus `filter.index`/`filter.startingIndex` select a page. For a multi-source client, CoCreateDB leaves the global `filter.index` to the client and updates only its source entry in `filter.storages`, including source `count`, `startingIndex`, and the next source `index`. Source counts reflect query matches before `search` and pagination, matching MongoDB's `countDocuments(query)` behavior.

Database, array, and object records use the same record contract: create writes the record and indexes its supported values through the recursive index processor; read resolves IDs or names through those indexes before loading JSON; update diffs old and new index entries; delete removes indexed values and the record. Database and array metadata therefore receive the same automatic field indexing as stored objects. Their `created` and `updated` audit fields use `{ on, by }`, following the object CRUD convention; `by` comes from `user_id` or `clientId` when supplied. Array metadata stores total objects in `length`; database metadata stores totals in `arrayLength` and `objectLength`. These values are ordinary indexed metadata fields maintained through record updates. Query `count` remains the number of records returned by the matching source before search and pagination.

Object create accepts one object or an array. Read accepts an object with `_id`, an equality query such as `{ fieldA: 'a' }`, or no query to enumerate the array. Query matching uses `queryData` from `@cocreate/utils`, including its field operators (`$eq`, `$ne`, `$not`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$all`, `$elemMatch`, `$size`, `$exists`, `$regex`, `$type`, and `$mod`) and logical operators (`$and`, `$or`, and `$nor`). Equality conditions can use CoCreateDB indexes to find candidates; the shared utility then checks matches. Other query shapes currently scan candidate objects. Equality preserves value types, so number `9` and string `'9'` are distinct. Range operators use JavaScript's native relational operators without type normalization; for example, `'20' > 10` is true while `'20' > '3'` is false because string-to-string comparison is lexical. Updates use `createUpdate` from `@cocreate/utils`, including its field and array operators; CoCreateDB maintains indexes from the resulting object. `$set` remains supported as a CoCreateDB convenience. Updates can target an object by `_id` or `filter.query`; deletes accept an object with `_id` or a query filter. Responses include the affected `object` array.

The array field-catalog root's `count` is the number of stored objects, maintained through the one-entry-per-object `_id` index. `catalogCount` counts catalog mappings. Each index node's `count` describes the entries in that node or subtree. Empty key/type roots are removed from the catalog after their final entry is deleted.

## Automatic indexes

On create, CoCreateDB creates an independent index for `_id` and each supported field path. Nested object leaves use dot notation, so `profile.city` is indexed as its own key. Array elements are indexed under their field path. No compound indexes are created automatically; a query combining fields can use the independent indexes. Custom indexes for other purposes can be considered later.

The current ordered index supports finite numbers, strings, booleans, explicit `null`, and arrays in separate type branches. Ordinary objects are recursively indexed by full dot-notation leaf paths. Arrays are terminal values: their complete contents are stored as chunked JSON under the field index's `values/` directory, and one digest entry points to each array value. Array contents do not create positional or nested field index paths. The object document remains the source used to return query results.

Array membership, `$all`, `$elemMatch`, `$size`, and other supported shared query operators inspect the complete terminal array values, then the normal query utility verifies matching documents. Queries into properties of objects inside arrays (for example, `projects.name`) remain supported by the query utility but currently scan the candidate documents because those nested paths are intentionally not indexed. Bracket paths such as `projects[0].name` use the shared notation/query behavior and do not create positional index branches. Large array values are stored in bounded JSON chunks so index nodes stay within `maxIndexBytes`; array edits replace one terminal value entry rather than maintaining an index for each position.

## Distributed index partitions

When initialized by `@cocreate/cluster`, `server.DB` is registered with CoCreate CRUD as `cocreate-db`. Its filesystem root defaults to `./.cocreate/db` and can be changed with `COCREATE_DB_DIRECTORY`.

Every regular index root or node written by CoCreateDB is recorded in the recursive Distributed Index as a partition path and the IDs of nodes holding it. The mapping is stored locally under `distributed/partitions/index/`; `distributed` data is never sent to external storage. When an index partition is first acquired, the new holder is added. When a regular index partition changes or is removed, the update is sent only to its recorded holders. Unchanged holder mappings do not generate availability updates. Index partition files retain their normal `first`, `last`, `count`, and entry metadata.

If recursive traversal needs an index file that is missing locally, CoCreateDB checks the partition holder map and requests that exact file from a holder over the targeted Cluster mesh. The received file is validated, written locally, and the node is registered as another holder. An advertised partition that no holder can provide produces an error rather than an empty query result. A configured file-level storage fallback is not implemented yet.

The existing database/array/object availability map remains in place for the current exact-ID metadata and document acquisition path. It is transitional: the agreed direction is to use the regular index trail and index-partition locations to resolve data, rather than make a separate object-location map the query architecture. Acquired documents are still materialized through CRUD/indexing before response projection. Initial partition-map snapshot transfer to a clean node, external storage fallback, and chunked terminal-array value transfer remain open implementation work.

CoCreateDB does not currently upload filesystem files to external storage. No shared file-level adapter contract exists in the current CoCreate CRUD provider drivers. If one is introduced, the proposed minimum is individual-file `read`, `write`, and `delete` operations addressed by validated database/array/entity IDs and a logical file kind; CoCreateDB must never pass a `distributed/` path to that adapter. Distributed Index files remain local Cluster metadata.

## Index API

The index primitive remains separately usable:

```js
import { createIndex } from '@cocreate/db'

const index = createIndex({ directory: './example-storage' })
await index.set('example-db', 'users', 'age', 31, '0123456789abcdef01234567')

for await (const entry of index.scan('example-db', 'users', 'age', {
    type: 'number'
})) {
    console.log(entry) // { value: 31, objectId: '0123456789abcdef01234567' }
}
```

The logical index address is `database + array + key`. In `createDB`, logical names resolve to stable database and array IDs before object/index access; the returned `db.index` facade continues to accept logical names. Each array ID directory contains an `index/` directory. `index.json` is the catalog tree's stable root. It stores entries while they fit; when it exceeds the configured byte limit, the entries move into 32-character hexadecimal child nodes and the root points to them. Those catalog nodes can split recursively like field-index nodes. Indexes use filesystem persistence by default without an in-memory node cache; opt into a Map cache with `createIndex({ cache: true })` or `createDB({ cache: true })`.

`createIndex({ maxBytes })` and `createDB({ maxIndexBytes })` set the serialized byte limit for both catalog and field-index nodes. The default is 128 KiB; this is a tunable starting point, not a benchmark-derived optimum.

## Current limits

- The new ID-addressed layout does not automatically migrate data written under the previous `<database>/<array>` directory layout.
- Filesystem storage is a local prototype. Object payloads and indexes share the configured root; there is no cloud/storage-provider fetch path yet.
- Query matching and updates share `@cocreate/utils`; utility semantics and limitations are inherited. Equality and range queries can use field indexes, while other query conditions may scan candidate objects. Mixed-type range planning scans each indexed type branch to preserve native JavaScript comparison behavior. Index updates are maintained after shared update operators run, but multi-object updates are not transactional.
- Index-holder nodes receive full object create/update/delete mutations and the current database/array metadata after the corresponding index partition updates. This is event-driven replication for known holders; user subscription lifecycle and inactive-node pruning are still future steps.
- Object requests target one database and one array; array operations target one database. Multi-target object fan-out is not implemented.
- Index partition acquisition is targeted by the local partition-holder map. A clean-node holder-map snapshot, restart reconstruction, external storage fallback, and chunked terminal-array value acquisition are not implemented yet.
- The legacy peer data path still targets exact `_id` reads using entity availability references. It is transitional; replacing it with complete index-trail resolution for documents and storage remains future work. Document mutation delivery has no durable acknowledgement/retry or reconnect recovery, and concurrent cross-node writes have no version conflict handling.
- Index and object writes are not a multi-file transaction. Server-integrated writes are serialized through the primary, but standalone multi-process writers are unsupported; the prototype does not provide crash recovery or distributed consistency.
- Missing, empty, or unsupported field values do not currently receive index entries. The stored object remains intact.

## Development

Run the tests with Node.js:

```sh
npm test
```

Tests use temporary storage roots and verify create/read/update/delete flows, field and nested-field removal, object counts, empty-index pruning, per-field indexes, ordered scans, splits, persistence after reopening, and Cluster propagation of full document mutations to index-partition holders.

## Package and repository

```sh
npm install @cocreate/db
```

[CoCreateJS/db](https://github.com/CoCreateJS/db)

## License

AGPL-3.0. See [LICENSE](LICENSE).
