import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createIndex } from '../src/index.js'
import { createDB } from '../src/object/index.js';
import { enableMemoryCache, removeMemoryPath } from '../src/memory.js';

const fixture = async run => {
    const directory = await mkdtemp(join(tmpdir(), 'coc-partition-lookups-'));
    try { await run(directory); }
    finally { removeMemoryPath(directory); await rm(directory, { recursive: true, force: true }); }
};

for (const cache of [false, true]) {
    test(`index reads reuse live nodes with memory caching and index cache ${cache}`, async () => fixture(async directory => {
        enableMemoryCache(directory);
        const index = createIndex({ directory, cache });
        await index.create('db', 'items', 'value', 'original', 'one');
        const first = await index.read('db', 'items', 'value');
        assert.strictEqual((await index.read('db', 'items', 'value')).indexes.string, first.indexes.string);
        await index.create('db', 'items', 'value', 'second', 'two');
        assert.equal((await index.read('db', 'items', 'value')).indexes.string.length, 2);
    }));
}

test('bulk partition lookup follows split catalogs and refreshes after mutations', async () => fixture(async directory => {
    const index = createIndex({ directory, maxBytes: 1024 });
    const entries = Array.from({ length: 24 }, (_, i) => [`field${i}`, i]);
    for (const [key, value] of entries) await index.create('db', 'items', key, value, 'object');
    const expected = new Set();
    for (const [key, value] of entries) expected.add(await index.locatePartition('db', 'items', key, value, 'object'));
    assert.deepEqual(await index.locatePartitions('db', 'items', [...entries, entries[0]], 'object'), expected);
    await index.delete('db', 'items', entries[0][0], entries[0][1], 'object');
    assert.equal((await index.locatePartitions('db', 'items', [entries[0]], 'object')).size, 0);
    await index.create('db', 'items', entries[0][0], 100, 'object');
    const paths = await index.locatePartitions('db', 'items', [[entries[0][0], 100]], 'object');
    assert.equal(paths.size, 1);
    const leaf = await index.readPartition([...paths][0]);
    assert.deepEqual(leaf.entries, [[100, 'object']]);
}));

test('document propagation retains holders from unchanged fields and old partitions', async () => fixture(async directory => {
    const holders = new Map();
    const published = [];
    const db = createDB({ directory, memoryCache: true,
        partitionAdapter: { get: async path => {
            if (!holders.has(path)) holders.set(path, `holder-${holders.size}`);
            return [holders.get(path)];
        } },
        documentMutationAdapter: { publish: async mutation => published.push(mutation) }
    });
    const scope = { database: 'db', array: 'items' };
    const created = await db.send({ ...scope, method: 'object.create', object: { left: 1, right: 2 } });
    assert.equal(created.success, true, created.error);
    const original = new Set(published[0].targets);
    const updated = await db.send({ ...scope, method: 'object.update', object: { _id: created.object[0]._id, left: 3 } });
    assert.equal(updated.success, true, updated.error);
    for (const holder of original) assert.ok(published[1].targets.includes(holder));
    assert.equal(published[1].operation, 'update');
    assert.equal(published[1].object.$update.left, 3);
    assert.equal('right' in published[1].object, false);
    assert.strictEqual(published[1].object.$update, updated.object[0].$update);
}));

test('a successful update response waits for pending index work and exposes the new query value', async () => fixture(async directory => {
    let block = false;
    let entered;
    let release;
    const reachedIndex = new Promise(resolve => { entered = resolve; });
    const finishIndex = new Promise(resolve => { release = resolve; });
    const db = createDB({ directory, nodeId: 'write-owner', memoryCache: true,
        partitionAdapter: { onLocalChange: async (payload, apply) => {
            const result = await apply({ partitionId: payload.path, nodeId: 'write-owner', operation: payload.operation === 'remove' ? 'remove' : 'add' });
            if (block) { block = false; entered(); await finishIndex; }
            return result;
        } }
    });
    const scope = { database: 'db', array: 'items' };
    const created = await db.send({ ...scope, method: 'object.create', object: { value: 1 } });
    assert.equal(created.success, true, created.error);
    block = true;
    let completed = false;
    const pending = db.send({ ...scope, method: 'object.update', object: { _id: created.object[0]._id, value: 2 } })
        .then(result => { completed = true; return result; });
    await reachedIndex;
    try { assert.equal(completed, false); }
    finally { release(); }
    assert.equal((await pending).success, true);
    removeMemoryPath(directory);
    const fresh = createDB({ directory });
    assert.equal((await fresh.send({ ...scope, method: 'object.read', filter: { query: { value: 2 } } })).object.length, 1);
    assert.equal((await fresh.send({ ...scope, method: 'object.read', filter: { query: { value: 1 } } })).object.length, 0);
}));
