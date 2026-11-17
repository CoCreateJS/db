import https from 'node:https';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const directory = fileURLToPath(new URL('.', import.meta.url));
const label = process.argv[2];
if (!/^[a-z0-9-]+$/.test(label || '')) throw new Error('Supply a run label');
const base = 'https://dev.cocreatejs.com';
const paths = ['/components/hero.html', '/'];
const warmups = 3;
const samplesPerPath = 20;
const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
const hash = value => createHash('sha256').update(value).digest('hex');
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
await mkdir(join(directory, 'bodies'), { recursive: true });

async function request(path) {
    const started = performance.now();
    return new Promise((resolve, reject) => {
        const req = https.get(new URL(path, base), {
            agent, headers: {
                'User-Agent': 'CoCreate-storage-comparison/1',
                'Accept': 'text/html', 'Cache-Control': 'no-cache'
            }
        }, response => {
            const ttfbMs = performance.now() - started;
            const chunks = [];
            response.on('error', reject);
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => {
                const body = Buffer.concat(chunks);
                resolve({
                    body,
                    sample: {
                        path, status: response.statusCode, bytes: body.length,
                        ttfbMs, totalMs: performance.now() - started,
                        sha256: hash(body),
                        normalizedSha256: hash(body.toString('utf8').replace(/[0-9a-f]{24}/gi, '<object-id>')),
                        cacheControl: response.headers['cache-control'],
                        contentType: response.headers['content-type'],
                        remoteAddress: response.socket?.remoteAddress,
                        reusedSocket: req.reusedSocket
                    }
                });
            });
        });
        req.setTimeout(20000, () => req.destroy(new Error('HTTP request timeout')));
        req.on('error', reject);
    });
}

const run = { label, base, startedAt: new Date().toISOString(), warmups, samplesPerPath, summaries: [], samples: [] };
try {
    for (const path of paths) {
        for (let i = 0; i < warmups; i++) {
            const { sample } = await request(path);
            if (sample.status !== 200) throw new Error(`Warmup returned ${sample.status} for ${path}`);
        }
        const samples = [];
        for (let i = 0; i < samplesPerPath; i++) {
            const { body, sample } = await request(path);
            if (i === 0) await writeFile(join(directory, 'bodies', `${label}-${path === '/' ? 'root' : 'hero'}.html`), body);
            samples.push(sample);
            run.samples.push(sample);
            if (sample.status !== 200) throw new Error(`Sample returned ${sample.status} for ${path}`);
        }
        const total = samples.map(sample => sample.totalMs);
        const ttfb = samples.map(sample => sample.ttfbMs);
        const summary = {
            path, requests: samples.length, statuses: [...new Set(samples.map(sample => sample.status))],
            bytes: [...new Set(samples.map(sample => sample.bytes))],
            hashes: [...new Set(samples.map(sample => sample.sha256))],
            normalizedHashes: [...new Set(samples.map(sample => sample.normalizedSha256))],
            totalMs: { min: Math.min(...total), mean: total.reduce((sum, value) => sum + value, 0) / total.length, p50: percentile(total, .5), p95: percentile(total, .95), max: Math.max(...total) },
            ttfbMs: { p50: percentile(ttfb, .5), p95: percentile(ttfb, .95) }
        };
        run.summaries.push(summary);
        console.log(JSON.stringify(summary));
    }
} catch (error) {
    run.error = error.message;
    process.exitCode = 1;
} finally {
    agent.destroy();
    run.finishedAt = new Date().toISOString();
    await writeFile(join(directory, `${label}.json`), JSON.stringify(run, null, 2) + '\n');
    await writeFile(join(directory, `${label}.jsonl`), run.samples.map(sample => JSON.stringify(sample)).join('\n') + '\n');
}
