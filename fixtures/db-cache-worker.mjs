import { EventEmitter } from 'node:events';
import { createDB, initializeServerDB } from '../src/index.js';

const directory = process.env.COCREATE_TEST_DB_DIRECTORY;
const pending = new Map();
let sequence = 0;
const server = Object.assign(new EventEmitter(), { id: 'cache-node', isPrimary: false, cluster: new EventEmitter() });
server.cluster.send = () => {};
server.send = payload => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    process.send({ type: 'request-primary', id, payload });
});
const local = createDB({ directory, memoryCache: true });
const db = initializeServerDB(server, { directory, memoryCache: true });
process.on('message', async message => {
    if (message.type === 'primary-response') {
        const task = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) task.reject(new Error(message.error));
        else task.resolve(message.result);
        return;
    }
    if (message.type !== 'command') return;
    try {
        const result = await (message.local ? local : db).send(message.payload);
        process.send({ type: 'command-response', id: message.id, result });
    } catch (error) {
        process.send({ type: 'command-response', id: message.id, error: error.message });
    }
});
process.send({ type: 'ready' });
