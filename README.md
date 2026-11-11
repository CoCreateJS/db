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

Run the checked-in example to populate the ignored `example-storage/` folder with real object and index files:

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

`send()` supports create/read/update/delete for databases and arrays, and object CRUD. Database and array create/delete requests accept one name or a list of names. Update renames one target with `database` or `array` set to the current name and `name` (or `newName`) set to the new name; an optional `config` object is merged into its metadata. Database reads return metadata records in `response.database`; each database includes its arrays and their object counts. Array reads return records in `response.array`, with each record carrying its `name`, stable `_id`, object `count`, and `$database` reference. Array operations require one database name. Object writes can create missing database and array catalog entries implicitly. Deleting an array removes its objects and indexes; deleting a database removes all of its arrays and data.

Read requests use the shared CoCreate filter shape: `filter.query` is evaluated with `queryData`, `filter.search` with `searchData`, `filter.sort` with `sortData`, `filter.key` applies an inclusion/exclusion projection, and `filter.limit` plus `filter.index`/`filter.startingIndex` select a page. For a multi-source client, CoCreateDB leaves the global `filter.index` to the client and updates only its source entry in `filter.storages`, including source `count`, `startingIndex`, and the next source `index`. Source counts reflect query matches before `search` and pagination, matching MongoDB's `countDocuments(query)` behavior.

Database, array, and object records use the same record contract: create writes the record and indexes its supported values through the recursive index processor; read resolves IDs or names through those indexes before loading JSON; update diffs old and new index entries; delete removes indexed values and the record. Database and array metadata therefore receive the same automatic field indexing as stored objects. Their `created` and `updated` audit fields use `{ on, by }`, following the object CRUD convention; `by` comes from `user_id` or `clientId` when supplied. An array record's `count` tracks its objects, while a database's `count` tracks arrays and `objectCount` tracks objects. These counters are themselves ordinary indexed metadata fields and are updated through the same record update path.

Object create accepts one object or an array. Read accepts an object with `_id`, an equality query such as `{ fieldA: 'a' }`, or no query to enumerate the array. Query matching uses `queryData` from `@cocreate/utils`, including its field operators (`$eq`, `$ne`, `$not`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$all`, `$elemMatch`, `$size`, `$exists`, `$regex`, `$type`, and `$mod`) and logical operators (`$and`, `$or`, and `$nor`). Equality conditions can use CoCreateDB indexes to find candidates; the shared utility then checks matches. Other query shapes currently scan candidate objects. Equality preserves value types, so number `9` and string `'9'` are distinct. Range operators use JavaScript's native relational operators without type normalization; for example, `'20' > 10` is true while `'20' > '3'` is false because string-to-string comparison is lexical. Updates use `createUpdate` from `@cocreate/utils`, including its field and array operators; CoCreateDB maintains indexes from the resulting object. `$set` remains supported as a CoCreateDB convenience. Updates can target an object by `_id` or `filter.query`; deletes accept an object with `_id` or a query filter. Responses include the affected `object` array.

The array field-catalog root's `count` is the number of stored objects, maintained through the one-entry-per-object `_id` index. `catalogCount` counts catalog mappings. Each index node's `count` describes the entries in that node or subtree. Empty key/type roots are removed from the catalog after their final entry is deleted.

## Automatic indexes

On create, CoCreateDB creates an independent index for `_id` and each supported field path. Nested object leaves use dot notation, so `profile.city` is indexed as its own key. Array elements are indexed under their field path. No compound indexes are created automatically; a query combining fields can use the independent indexes. Custom indexes for other purposes can be considered later.

The current ordered index supports finite numbers, strings, booleans, and explicit `null` values in separate type branches. Objects are recursively indexed by their leaf fields. Arrays are indexed by their scalar elements and nested object leaves. The complete JSON object is stored even when a valid JSON value has no index entry (for example, an empty object or array).

## Distributed availability indexes

When initialized by `@cocreate/cluster`, `server.DB` is a local `createDB()` instance. Its filesystem root defaults to `./.cocreate/db` and can be changed with `COCREATE_DB_DIRECTORY`. Database, array, and object creates add the local server ID to a sibling `distributed/index.json`; deletes remove only that server's reference. Updates and reads do not change availability. Deleting arrays or databases preserves nested distributed indexes that still contain references from other servers.

The Distributed Index reuses `createIndex` with the `distributed/` directory name. At each level it maps the entity ID as the indexed `_id` value and the server ID as the index entry's `objectId`. The database-level path is `databases/distributed/`; array and object paths are `databases/<database-id>/arrays/distributed/` and `databases/<database-id>/arrays/<array-id>/distributed/`. The directories are local layout only; each root and partition is an individual JSON file.

`server.DB.getDistributed({ database, array, objectId })` returns the server IDs for that entity. `server.DB.updateDistributed({ databaseId, arrayId, objectId, nodeId, operation })` applies an idempotent local index update and never broadcasts by itself. Normal local availability transitions emit the incremental `db.distributed` event; incoming events update the primary's local index and are not rebroadcast. Worker CRUD writes and availability updates are serialized through the primary to keep the shared filesystem index single-writer. Set `COCREATE_DB_DIRECTORY` to the same filesystem path for all workers on a server.

CoCreateDB does not currently upload any filesystem files to external storage. Distributed Index files are local Cluster metadata and must remain excluded if an external file persistence adapter is added.

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
- Subscriptions, retention cleanup, and remote adapters are future steps.
- Object requests target one database and one array; array operations target one database. Multi-target object fan-out is not implemented.
- Index and object writes are not a multi-file transaction. Server-integrated writes are serialized through the primary, but standalone multi-process writers are unsupported; the prototype does not provide crash recovery or distributed consistency.
- Missing, empty, or unsupported field values do not currently receive index entries. The stored object remains intact.

## Development

Run the tests with Node.js:

```sh
npm test
```

Tests use temporary storage roots and verify create/read/update/delete flows, field and nested-field removal, object counts, empty-index pruning, per-field indexes, ordered scans, splits, and persistence after reopening.

## Package and repository

```sh
npm install @cocreate/db
```

[CoCreateJS/db](https://github.com/CoCreateJS/db)

## License

AGPL-3.0. See [LICENSE](LICENSE).
