import fs from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Config from '../../../../config/src/server.js';
import { HTML } from '../../../../render/src/server/index.js';

const mode = process.argv[2];
const output = new URL('./', import.meta.url);
const root = '/home/ubuntu/Dev';
const existingFixture = process.argv[3];
const fixture = existingFixture || await fs.mkdtemp('/tmp/coc-db-isolated-');
if (Config.get('persistence')) throw Error('External persistence must be unset for this benchmark');
const hash = s => createHash('sha256').update(s).digest('hex');
const organization_id = '5ff747727005da1c272740ab';
const host = 'dev.cocreatejs.com';
const base = { organization_id, host, storage: 'dev', database: 'app', array: 'files' };
const audit = JSON.parse(await fs.readFile(new URL('../db-vs-mongodb-20261112/source-comparison.json', import.meta.url)));
const paths = [...new Set(['/index.html', '/404.html', ...audit.components.filter(x => !x.bothMissing).map(x => x.pathname)])];
const documents = [];
for (const pathname of paths) {
    const src = await fs.readFile(join(root, 'CoCreate-app/src', pathname), 'utf8');
    documents.push({ _id: hash(pathname).slice(0, 24), pathname, host: ['*'], src, 'content-type': pathname.endsWith('.html') ? 'text/html' : 'image/svg+xml' });
}
const sourceChecks = audit.components.filter(x => !x.bothMissing).map(x => ({ pathname: x.pathname,
    equal: hash(documents.find(d => d.pathname === x.pathname).src) === x.dbSha256 }));
let db;
const meshCounts = new Map();
const options = { directory: fixture, memoryCache: true, cache: false, writeBehind: false };
if (mode === 'previous-flat') {
    const { createDB } = await import('/tmp/coc-db-memory-before-chdrhkm1/src/index.js');
    db = createDB(options);
} else if (mode === 'current-flat') {
    const { createDB } = await import('../../../src/object/index.js');
    db = createDB(options);
} else if (mode === 'current-scoped') {
    const { createDB } = await import('../../../src/scoped.js');
    db = createDB(options);
} else if (['previous-primary', 'current-primary', 'current-staged-primary'].includes(mode)) {
    const { initializeServerDB } = await import(mode === 'previous-primary'
        ? '/tmp/coc-db-memory-before-chdrhkm1/src/server.js' : '../../../src/server.js');
    const server = Object.assign(new EventEmitter(), { id: 'isolated-node', isPrimary: true,
        workers: Object.assign(new Map(), { distribution: new Map() }), send: async p => p,
        cluster: Object.assign(new EventEmitter(), { send: p => meshCounts.set(p.method, (meshCounts.get(p.method) || 0) + 1) }) });
    db = initializeServerDB(server, { ...options, writeBehind: mode === 'current-staged-primary', bootstrapPersistence: false });
} else throw Error('Unknown mode');
const check = response => {
    if (response?.success === false || (Array.isArray(response?.error) ? response.error.length : response?.error)) throw Error(JSON.stringify(response.error));
    return response;
};
const samples = {};
const timed = async (label, operation, n = 20) => {
    const rows = [];
    for (let i = 0; i < n; i++) { const start = performance.now(); const value = await operation(); rows.push({ ms: performance.now() - start, ...value }); }
    samples[label] = rows;
};
const request = pathname => ({ ...base, method: 'object.read', filter: { query: { host: { $in: [host, '*'] }, pathname }, limit: 1 } });
let readCount = 0;
const read = async pathname => { readCount++; return check(await db.send(request(pathname))).object?.[0]; };
const render = async () => {
    const before = readCount;
    const file = await read('/index.html');
    const html = await HTML({ file, organization: { _id: organization_id }, urlObject: new URL(`https://${host}/`),
        resolveFile: async pathname => await read(pathname) || await read('/404.html'),
        crud: { send: async payload => check(await db.send({ ...base, ...payload })) } });
    return { bytes: Buffer.byteLength(html), sha256: hash(html), reads: readCount - before };
};
try {
    if (!existingFixture) {
        const seedStart = performance.now();
        for (const object of documents) check(await db.send({ ...base, method: 'object.create', object }));
        await db.flush?.();
        const seedMs = performance.now() - seedStart;
        await db.close?.();
        db = null;
        const { stdout } = await promisify(execFile)(process.execPath, [new URL(import.meta.url).pathname, mode, fixture],
            { env: { ...process.env, COC_BENCH_SEED_MS: String(seedMs) }, maxBuffer: 1024 * 1024 });
        process.stdout.write(stdout);
    } else {
    const seedMs = Number(process.env.COC_BENCH_SEED_MS);
    await timed('first-read', async () => { const d = await read('/components/hero.html'); if (!d) throw Error('missing file'); return { sha256: hash(d.src) }; }, 1);
    await timed('warm-read', async () => { const d = await read('/components/hero.html'); if (!d || hash(d.src) !== hash(documents.find(d => d.pathname === '/components/hero.html').src)) throw Error('source mismatch'); return { bytes: Buffer.byteLength(d.src), sha256: hash(d.src) }; });
    await timed('first-render', render, 1);
    await timed('warm-render', render, 5);
    await timed('write-and-render', async () => {
        const start = performance.now();
        const object = { label: 'indexing-workload', revision: performance.now() };
        for (let i = 0; i < 40; i++) object[`field${i}`] = `value-${i}`;
        check(await db.send({ ...base, array: 'benchmark_work', method: 'object.create', object }));
        const writeAckMs = performance.now() - start;
        await new Promise(resolve => setTimeout(resolve, 10));
        const readStart = performance.now();
        const rendered = await render();
        return { ...rendered, writeAckMs, renderMs: performance.now() - readStart };
    }, 5);
    const summaries = Object.fromEntries(Object.entries(samples).map(([label, rows]) => { const a = rows.map(x => x.ms).sort((a,b) => a-b); return [label, { n: a.length, minMs: a[0], medianMs: a[Math.floor(a.length/2)], maxMs: a.at(-1), hashes: [...new Set(rows.map(x => x.sha256))], bytes: [...new Set(rows.map(x => x.bytes).filter(Boolean))], reads: [...new Set(rows.map(x => x.reads).filter(Boolean))] }]; }));
    const result = { mode, fixture, externalPersistence: false, writeBehind: mode === 'current-staged-primary', documents: documents.length,
        sourceChecks, rootSourceMatches: hash(documents.find(d=>d.pathname==='/index.html').src) === audit.rootSha256,
        seedMs, summaries, samples, memory: db.memoryStats(), meshCounts: Object.fromEntries(meshCounts) };
    await fs.writeFile(new URL(`${mode}.json`, output), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ mode, seedMs, summaries, memory: result.memory, meshCounts: result.meshCounts }));
    }
} finally { await db?.close?.(); if (!existingFixture) await fs.rm(fixture, { recursive: true, force: true }); }
