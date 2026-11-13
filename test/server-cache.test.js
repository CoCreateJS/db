import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { fork } from 'node:child_process';
import { access, mkdtemp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { initializeServerDB } from '../src/index.js';

test('worker CRUD uses only the primary engine and cache through awaited IPC', { timeout: 30000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'coc-db-worker-cache-'));
    const primary = Object.assign(new EventEmitter(), { id: 'cache-node', isPrimary: true, cluster: new EventEmitter() });
    primary.cluster.send = () => {};
    primary.send = async payload => {
        const replies = await Promise.all(primary.rawListeners(payload.method).map(listener => listener(payload)));
        return replies[0] ?? payload;
    };
    const db = initializeServerDB(primary, { directory, memoryCache: true, memoryOnly: true });
    const scope = { organization_id: '000000000000000000000001', storage: 'production', database: 'cache-test', array: 'items' };
    const created = await db.send({ ...scope, method: 'object.create', object: { value: 1 } });
    assert.equal(created.success, true, created.error);
    const objectId = created.object[0]._id;
    const worker = fork(new URL('../fixtures/db-cache-worker.mjs', import.meta.url), [], {
        env: { ...process.env, COCREATE_TEST_DB_DIRECTORY: join(directory, 'must-not-exist') }, stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    });
    t.after(async () => {
        await db.close();
        const stopped = once(worker, 'exit');
        worker.kill();
        await stopped;
        await rm(directory, { recursive: true, force: true });
    });
    const commands = new Map();
    let sequence = 0;
    let requests = 0;
    worker.on('message', async message => {
        if (message.type === 'request-primary') {
            requests++;
            assert.equal(message.payload.method, 'db.send');
            assert.equal(message.payload.master, true);
            assert.equal(message.payload.broadcast, false);
            try { worker.send({ type: 'primary-response', id: message.id, result: await primary.send(message.payload) }); }
            catch (error) { worker.send({ type: 'primary-response', id: message.id, error: error.message }); }
        } else if (message.type === 'command-response') {
            const task = commands.get(message.id);
            commands.delete(message.id);
            if (message.error) task.reject(new Error(message.error));
            else task.resolve(message.result);
        }
    });
    const ready = await new Promise(resolve => worker.on('message', message => { if (message.type === 'ready') resolve(message); }));
    assert.deepEqual(ready.driverKeys, ['send', 'persistence']);
    assert.deepEqual(ready.listeners, []);
    assert.deepEqual(ready.meshListeners, []);
    const command = payload => new Promise((resolve, reject) => {
        const id = ++sequence;
        commands.set(id, { resolve, reject });
        worker.send({ type: 'command', id, payload });
    });
    const read = { ...scope, method: 'object.read', object: { _id: objectId } };
    assert.equal((await command(read)).object[0].value, 1, 'Worker read uses the primary');
    assert.equal((await db.send({ ...scope, method: 'object.update', object: { _id: objectId, value: 2 } })).success, true);
    assert.equal((await command(read)).object[0].value, 2, 'The worker sees the updated primary cache');
    assert.equal((await command(read)).object[0].value, 2, 'A repeated worker read returns the current value');
    assert.equal((await command({ ...scope, method: 'object.update', object: { _id: objectId, value: 4 } })).success, true);
    assert.equal((await db.send(read)).object[0].value, 4, 'Primary sees the completed worker write');
    const queued = await Promise.all([
        db.send({ ...scope, method: 'object.update', object: { _id: objectId, value: 5 } }),
        db.send({ ...scope, method: 'object.read', filter: { query: { value: 5 } } }),
        db.send({ ...scope, method: 'object.read', filter: { query: { value: 4 } } })
    ]);
    assert.equal(queued[0].success, true);
    assert.equal(queued[1].object[0].value, 5, 'Reads wait for the preceding document and index update');
    assert.deepEqual(queued[2].object, [], 'Reads cannot observe the removed index value');
    const increments = Array.from({ length: 12 }, (_, i) => (i % 2 ? command : db.send)({ ...scope, method: 'object.update', object: { _id: objectId, $inc: { value: 1 } } }));
    assert.ok((await Promise.all(increments)).every(result => result.success));
    assert.equal((await command(read)).object[0].value, 17, 'Queued writes preserve every increment');
    const rejected = await command({ ...scope, method: 'object.update', object: { _id: objectId, $inc: { value: 'invalid' } } });
    assert.equal(rejected.success, false, 'DB failure is returned as the original CRUD result');
    assert.equal((await command(read)).object[0].value, 17, 'A failure does not poison the queue');
    const newArray = { ...scope, array: 'new-items' };
    assert.equal((await db.send({ ...newArray, method: 'object.create', object: { value: 3 } })).success, true);
    assert.equal((await command({ ...newArray, method: 'object.read' })).object[0].value, 3);
    assert.equal((await db.send({ ...scope, method: 'object.delete', object: { _id: objectId } })).success, true);
    assert.deepEqual((await command(read)).object, []);
    assert.ok(requests >= 15, 'Reads and writes both crossed IPC');
    assert.ok(db.memoryStats().files > 0, 'Only the primary retains payloads');
    await assert.rejects(access(join(directory, 'must-not-exist')), { code: 'ENOENT' });
    assert.deepEqual(await readdir(directory), [], 'The primary core test also performs no persistence');
});
