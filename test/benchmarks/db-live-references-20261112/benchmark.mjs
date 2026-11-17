import fs from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { HTML } from '../../../../render/src/server/index.js';

const mode = process.argv[2];
if (!['checkpoint', 'live'].includes(mode)) throw Error('Use checkpoint or live');
const baseline = (await fs.readFile('/tmp/coc-db-live-baseline-path', 'utf8')).trim();
const { initializeServerDB } = await import(mode === 'checkpoint' ? `${baseline}/src/server.js` : '../../../src/server.js');
const directory = `/tmp/coc-db-live-benchmark-${mode}-${Date.now()}`;
const host = 'dev.cocreatejs.com';
const scope = { organization_id: '5ff747727005da1c272740ab', storage: 'dev', database: 'app', array: 'files', host };
const audit = JSON.parse(await fs.readFile(new URL('../db-vs-mongodb-20261112/source-comparison.json', import.meta.url)));
const paths = [...new Set(['/index.html', '/404.html', ...audit.components.filter(row => !row.bothMissing).map(row => row.pathname)])];
const hash = value => createHash('sha256').update(value).digest('hex');
const mesh = new Map();
const server = Object.assign(new EventEmitter(), { id: 'benchmark-node', isPrimary: true,
    workers: Object.assign(new Map(), { distribution: new Map() }), send: async payload => payload,
    cluster: Object.assign(new EventEmitter(), { send: payload => mesh.set(payload.method, (mesh.get(payload.method) || 0) + 1) }) });
const db = initializeServerDB(server, { directory, memoryOnly: mode === 'live', memoryCache: true, writeBehind: false });
const originalClone = globalThis.structuredClone;
let clones = 0;
const send = async payload => {
    const result = await db.send({ ...scope, ...payload });
    if (!result.success || result.error?.length) throw Error(JSON.stringify(result.error));
    return result;
};
let reads = 0;
const read = async pathname => {
    reads++;
    return (await send({ method: 'object.read', filter: { query: { host: { $in: [host, '*'] }, pathname }, limit: 1 } })).object[0];
};
const render = async () => {
    const before = reads;
    const file = await read('/index.html');
    const html = await HTML({ file, organization: { _id: scope.organization_id }, urlObject: new URL(`https://${host}/`),
        resolveFile: async pathname => await read(pathname) || await read('/404.html'), crud: { send } });
    return { sha256: hash(html), bytes: Buffer.byteLength(html), reads: reads - before };
};
try {
    const started = performance.now();
    for (const pathname of paths) {
        const src = await fs.readFile(`/home/ubuntu/Dev/CoCreate-app/src${pathname}`, 'utf8');
        await send({ method: 'object.create', object: { _id: hash(pathname).slice(0, 24), pathname, src, host: ['*'], 'content-type': pathname.endsWith('.html') ? 'text/html' : 'image/svg+xml' } });
    }
    await db.flush();
    const seedMs = performance.now() - started;
    globalThis.structuredClone = (...args) => {
        clones++;
        if (mode === 'live') throw Error('Core path attempted to clone');
        return originalClone(...args);
    };
    for (let i = 0; i < 5; i++) await read('/components/hero.html');
    for (let i = 0; i < 3; i++) await render();
    const rows = {}, cloneCounts = {};
    for (const [name, operation, count] of [['file', () => read('/components/hero.html'), 50], ['render', render, 20]]) {
        const samples = [], before = clones;
        for (let i = 0; i < count; i++) {
            const start = performance.now();
            const value = await operation();
            samples.push({ ms: performance.now() - start, ...(name === 'render' ? value : { sha256: hash(value.src) }) });
        }
        cloneCounts[name] = clones - before;
        const sorted = samples.map(row => row.ms).sort((a,b) => a-b);
        rows[name] = { n: count, medianMs: sorted[Math.floor(count/2)], p95Ms: sorted[Math.ceil(count*.95)-1],
            hashes: [...new Set(samples.map(row => row.sha256))], samples };
    }
    let directoryExists = true;
    try { await fs.access(directory); } catch { directoryExists = false; }
    if (mode === 'live' && directoryExists) throw Error('Memory-only benchmark wrote files');
    const result = { mode, checkpoint: '3244ff0', baseline, memoryOnly: mode === 'live', externalPersistence: false,
        documents: paths.length, seedMs, directoryExists, cloneCounts, totalClonesIncludingWarmups: clones,
        rows, mesh: Object.fromEntries(mesh), memory: db.memoryStats() };
    await fs.writeFile(new URL(`${mode}.json`, import.meta.url), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ mode, seedMs, cloneCounts, directoryExists,
        file: { medianMs: rows.file.medianMs, p95Ms: rows.file.p95Ms }, render: { medianMs: rows.render.medianMs, p95Ms: rows.render.p95Ms, hashes: rows.render.hashes } }));
} finally {
    globalThis.structuredClone = originalClone;
    await db.close();
    await fs.rm(directory, { recursive: true, force: true });
}
