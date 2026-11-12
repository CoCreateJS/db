import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { initializeServerDB } from '../src/index.js';

test('worker CRUD sees primary updates, new arrays, and deletes despite a stale process cache', { timeout: 30000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'coc-db-worker-cache-'));
    const primary = Object.assign(new EventEmitter(), { id: 'cache-node', isPrimary: true, cluster: new EventEmitter() });
    primary.cluster.send = () => {};
    primary.send = async payload => {
        const replies = await Promise.all(primary.rawListeners(payload.method).map(listener => listener(payload)));
        return replies[0] ?? payload;
    };
    const db = initializeServerDB(primary, { directory, memoryCache: true });
    const scope = { database: 'cache-test', array: 'items' };
    const created = await db.send({ ...scope, method: 'object.create', object: { value: 1 } });
    assert.equal(created.success, true, created.error);
    const objectId = created.object[0]._id;
    const worker = fork(new URL('../fixtures/db-cache-worker.mjs', import.meta.url), [], {
        env: { ...process.env, COCREATE_TEST_DB_DIRECTORY: directory }, stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    });
    t.after(async () => {
        const stopped = once(worker, 'exit');
        worker.kill();
        await stopped;
        await rm(directory, { recursive: true, force: true });
    });
    const commands = new Map();
    let sequence = 0;
    worker.on('message', async message => {
        if (message.type === 'request-primary') {
            try { worker.send({ type: 'primary-response', id: message.id, result: await primary.send(message.payload) }); }
            catch (error) { worker.send({ type: 'primary-response', id: message.id, error: error.message }); }
        } else if (message.type === 'command-response') {
            const task = commands.get(message.id);
            commands.delete(message.id);
            if (message.error) task.reject(new Error(message.error));
            else task.resolve(message.result);
        }
    });
    await new Promise(resolve => worker.on('message', message => { if (message.type === 'ready') resolve(); }));
    const command = (payload, local = false) => new Promise((resolve, reject) => {
        const id = ++sequence;
        commands.set(id, { resolve, reject });
        worker.send({ type: 'command', id, payload, local });
    });
    const read = { ...scope, method: 'object.read', filter: { query: { _id: objectId } } };
    assert.equal((await command(read, true)).object[0].value, 1, 'Prime the separate process cache');
    assert.equal((await db.send({ ...scope, method: 'object.update', object: { _id: objectId, value: 2 } })).success, true);
    assert.equal((await command(read, true)).object[0].value, 1, 'The raw worker cache is stale');
    assert.equal((await command(read)).object[0].value, 2, 'CRUD must return the primary view');
    const newArray = { database: scope.database, array: 'new-items' };
    assert.equal((await db.send({ ...newArray, method: 'object.create', object: { value: 3 } })).success, true);
    assert.equal((await command({ ...newArray, method: 'object.read' })).object[0].value, 3);
    assert.equal((await db.send({ ...scope, method: 'object.delete', object: { _id: objectId } })).success, true);
    assert.deepEqual((await command(read)).object, []);
});
