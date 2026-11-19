import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const directory = resolve(process.argv[2])
if (!process.argv[2]) throw Error('Usage: node report-lifecycle-comparison.mjs <comparison-directory>')

async function resultFor(version) {
    const files = (await readdir(join(directory, version))).filter(file => file.endsWith('.json'))
    if (files.length !== 1) throw Error(`Expected one ${version} result in ${directory}`)
    return JSON.parse(await readFile(join(directory, version, files[0]), 'utf8'))
}

const oldRun = await resultFor('old')
const nextRun = await resultFor('next')
const old = oldRun.sizes[0]
const next = nextRun.sizes[0]
const oldSource = await readFile(join(directory, 'old-source.txt'), 'utf8').catch(() => 'dev commit unknown\n')
if (old.fixtureHash !== next.fixtureHash || old.size !== next.size)
    throw Error('The old and Next runs do not use the same fixture size and hash')

const ms = value => `${value.toFixed(3)} ms`
const ops = value => `${Math.round(value).toLocaleString()} ops/s`
const memory = value => `${(value / 1024 / 1024).toFixed(2)} MiB`
const rows = [
    ['Index entries per record', old.indexEntriesPerRecord, next.indexEntriesPerRecord],
    ['Create + index, whole batch', ms(old.createAndIndexMs), ms(next.createAndIndexMs)],
    ['Created records per second', ops(old.createRecordsPerSecond), ops(next.createRecordsPerSecond)],
    ['First UUID read after create', ms(old.postCreate.firstReadMs), ms(next.postCreate.firstReadMs)],
    ['First UUID update after create', ms(old.postCreate.firstUpdateMs), ms(next.postCreate.firstUpdateMs)],
    ['Cold UUID read after dataset build', ms(old.readUuid.coldMs), ms(next.readUuid.coldMs)],
    ['Warm UUID read p50 / throughput', `${ms(old.readUuid.p50Ms)} / ${ops(old.readUuid.opsPerSecond)}`, `${ms(next.readUuid.p50Ms)} / ${ops(next.readUuid.opsPerSecond)}`],
    ['Warm equality p50 / throughput', `${ms(old.readEquality.p50Ms)} / ${ops(old.readEquality.opsPerSecond)}`, `${ms(next.readEquality.p50Ms)} / ${ops(next.readEquality.opsPerSecond)}`],
    ['Warm nested p50 / throughput', `${ms(old.readNestedPath.p50Ms)} / ${ops(old.readNestedPath.opsPerSecond)}`, `${ms(next.readNestedPath.p50Ms)} / ${ops(next.readNestedPath.opsPerSecond)}`],
    ['Warm range p50 / throughput', `${ms(old.readRange.p50Ms)} / ${ops(old.readRange.opsPerSecond)}`, `${ms(next.readRange.p50Ms)} / ${ops(next.readRange.opsPerSecond)}`],
    ['Warm UUID update p50 / throughput', `${ms(old.updateUuid.p50Ms)} / ${ops(old.updateUuid.opsPerSecond)}`, `${ms(next.updateUuid.p50Ms)} / ${ops(next.updateUuid.opsPerSecond)}`],
    ['Delete batch throughput', ops(old.deleteBatch.recordsPerSecond), ops(next.deleteBatch.recordsPerSecond)],
    ['CPU user + system', `${(oldRun.sizes[0].cpuUsageUs.user / 1000).toFixed(1)} + ${(oldRun.sizes[0].cpuUsageUs.system / 1000).toFixed(1)} ms`, `${(next.cpuUsageUs.user / 1000).toFixed(1)} + ${(next.cpuUsageUs.system / 1000).toFixed(1)} ms`],
    ['RSS after workload', memory(old.memory.rss), memory(next.memory.rss)],
    ['Heap used after workload', memory(old.memory.heapUsed), memory(next.memory.heapUsed)]
]

const lines = [
    '# CoCreateDB lifecycle comparison',
    '',
    `- Fixture: deterministic lifecycle v2, ${old.size.toLocaleString()} records`,
    `- SHA-256: \`${old.fixtureHash}\``,
    `- Runtime: ${oldRun.node} on ${oldRun.platform}; ${oldRun.cpuCount} CPUs reported`,
    `- Samples: ${oldRun.samples}; warm percentiles follow 10 warmup operations`,
    `- Old source: \`${oldSource.trim()}\`; new source: this branch’s prototype.`,
    `- Raw results: [old](old/${(await readdir(join(directory, 'old'))).find(file => file.endsWith('.json'))}), [Next](next/${(await readdir(join(directory, 'next'))).find(file => file.endsWith('.json'))}).`,
    '',
    '| Metric | Old | Next |',
    '| --- | ---: | ---: |',
    ...rows.map(row => `| ${row[0]} | ${row[1]} | ${row[2]} |`),
    '',
    '## Reading the comparison',
    '',
    'Both runs use the same serialized fixture and query predicates. The tested UUID, equality, nested-path, and range reads each assert their expected result count. First-read/update timings are captured immediately after creating one additional object; warm timings include a cold sample, 10 warmups, and the configured measured samples.',
    '',
    `The indexed-entry counts differ (old ${old.indexEntriesPerRecord}, Next ${next.indexEntriesPerRecord} per record). The old engine indexes extra existence/container paths; Next currently indexes the scalar flattened leaves used by these queries. The create-and-index time is therefore a useful end-to-end prototype comparison, but not an equal-work indexing benchmark. Keep the coverage count beside throughput when evaluating future changes.`,
    '',
    'Old create-and-index combines request acknowledgment and the old engine’s index flush. Next indexes synchronously during create, so its create duration is the complete create-and-index duration. Delete throughput includes the old index flush and has no separate flush in Next. Disk durability, peer distribution, and external persistence are excluded from both runs.',
    '',
    'CPU and memory are process-level readings after the workload; they include runtime overhead and are sensitive to host load and garbage collection. Repeat the comparison on an idle host before treating small differences as stable.'
]

await writeFile(join(directory, 'report.md'), `${lines.join('\n')}\n`)
console.log(`report=${join(directory, 'report.md')}`)
