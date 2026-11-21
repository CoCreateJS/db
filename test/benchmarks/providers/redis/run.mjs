import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import fs from 'node:fs'
import { createServer } from 'node:net'
import { availableParallelism, cpus, freemem, release as osRelease, tmpdir, totalmem, version as osVersion } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from 'redis'
import { benchmarkUuid, createBenchmarkRecord, lifecycleRoot } from '../../../fixtures/lifecycle.mjs'
import { launch as launchChild } from '../../shared/child-process.mjs'
import { createProgressReporter, expectedCount as countExpected, expectedUuids as getExpectedUuids, parseStandardSizes, standardWorkloads } from '../../shared/workloads.mjs'

const script = fileURLToPath(import.meta.url)
const here = dirname(script)
const benchmarkRoot = resolve(here, '../..')
const redisVersion = '8.10.3'
const redisRoot = process.env.REDIS_SERVER_DIR ?? join(process.env.HOME, '.cache/cocreate-db-redis/8.10.3/extracted/server/usr')
const redisBinary = join(redisRoot, 'bin/redis-server')
const driverVersion = JSON.parse(await readFile(join(here, 'node_modules/redis/package.json'), 'utf8')).version
const percentile = (values, fraction) => {
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0
}
const stats = (values, elapsedMs) => ({
    samples: values.length, minMs: Math.min(...values), maxMs: Math.max(...values),
    meanMs: values.reduce((sum, value) => sum + value, 0) / values.length,
    p50Ms: percentile(values, .5), p95Ms: percentile(values, .95), p99Ms: percentile(values, .99),
    ...(elapsedMs === undefined ? {} : { totalMs: elapsedMs, opsPerSecond: values.length / elapsedMs * 1000 })
})
const revision = () => {
    try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: benchmarkRoot, encoding: 'utf8' }).trim() }
    catch { return null }
}
const recordEnvironment = () => ({
    date: new Date().toISOString(), node: process.version, platform: `${process.platform}-${process.arch}`,
    release: osRelease(), os: osVersion(), cpuModel: cpus()[0]?.model, cpuCount: availableParallelism(),
    totalMemoryBytes: totalmem(), freeMemoryBytesAtStart: freemem(),
    redisServerVersion: redisVersion, redisNodeDriverVersion: driverVersion,
    processModel: 'Redis server child process plus Node driver client over loopback TCP',
    persistence: 'RDB snapshots and AOF disabled; temporary Redis process and directory per independent run',
    durability: 'memory only; no replication or persistence', transport: 'RESP over 127.0.0.1 TCP',
    diskUsageBytes: 0, diskIO: null
})
const readProcess = pid => {
    if (!pid || process.platform !== 'linux') return null
    try {
        const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8')
        const fields = Object.fromEntries([...status.matchAll(/^(VmRSS|VmHWM|VmSize):\s+(\d+) kB$/gm)].map(m => [m[1], Number(m[2]) * 1024]))
        const counters = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').slice(fs.readFileSync(`/proc/${pid}/stat`, 'utf8').lastIndexOf(')') + 1).trim().split(/\s+/)
        fields.cpuTicks = Number(counters[11]) + Number(counters[12])
        return fields
    } catch { return null }
}
const expectedIds = (size, predicate, limit = 100) => getExpectedUuids(size, predicate, limit)
const expectedCount = countExpected
const compareIds = (documents, expected, label) => assert.deepEqual(documents.map(document => document.uuid), expected, `${label} UUIDs`)
async function measure(operation, validate, { samples, warmups }) {
    let before = performance.now()
    validate(await operation('first', 0))
    const firstOperationMs = performance.now() - before
    for (let i = 0; i < warmups; i++) validate(await operation('warmup', i))
    const values = []
    const start = performance.now()
    for (let i = 0; i < samples; i++) {
        before = performance.now()
        validate(await operation('sample', i))
        values.push(performance.now() - before)
    }
    return { firstOperationMs, warmups, measured: stats(values, performance.now() - start) }
}
async function freePort() {
    const server = createServer()
    await new Promise((resolvePromise, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolvePromise))
    const { port } = server.address()
    await new Promise(resolvePromise => server.close(resolvePromise))
    return port
}
async function startRedis(directory) {
    const port = await freePort()
    const child = spawn(redisBinary, [
        '--bind', '127.0.0.1', '--port', String(port), '--protected-mode', 'no', '--dir', directory,
        '--save', '', '--appendonly', 'no', '--daemonize', 'no', '--loglevel', 'warning',
        '--loadmodule', join(redisRoot, 'lib/redis/modules/rejson.so'),
        '--loadmodule', join(redisRoot, 'lib/redis/modules/redisearch.so')
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000) })
    const client = createClient({ url: `redis://127.0.0.1:${port}`, socket: { reconnectStrategy: false } })
    client.on('error', () => {})
    const start = performance.now()
    while (performance.now() - start < 15000) {
        if (child.exitCode !== null) throw Error(`Redis exited (${child.exitCode}): ${stderr}`)
        try { await client.connect(); await client.ping(); return { child, client, port, stderr } } catch {}
        await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
    }
    child.kill('SIGTERM')
    throw Error(`Redis did not become ready: ${stderr}`)
}
const schema = [
    '$.uuid', 'AS', 'uuid', 'TAG',
    '$._id', 'AS', 'objectId', 'TAG',
    '$.organization_id', 'AS', 'organization', 'TAG',
    '$.group', 'AS', 'group', 'TAG',
    '$.profile.team', 'AS', 'team', 'TAG',
    '$.rank', 'AS', 'rank', 'NUMERIC', 'SORTABLE',
    '$.active', 'AS', 'active', 'TAG',
    '$.bulkDelete', 'AS', 'bulkDelete', 'TAG',
    '$.createdAt', 'AS', 'createdAt', 'TAG',
    '$.profile.score', 'AS', 'score', 'NUMERIC',
    '$.profile.location.region', 'AS', 'region', 'TAG',
    '$.profile.location.verified', 'AS', 'verified', 'TAG',
    '$.payload', 'AS', 'payload', 'TAG',
    '$.revision', 'AS', 'revision', 'NUMERIC',
    '$.tags[0]', 'AS', 'tag0', 'TAG',
    '$.tags[1]', 'AS', 'tag1', 'TAG'
]
const search = async (client, query) => {
    const reply = await client.sendCommand(['FT.SEARCH', 'fixture_idx', query, 'SORTBY', 'rank', 'ASC', 'LIMIT', '0', '100', 'RETURN', '1', '$', 'DIALECT', '2'])
    const documents = []
    for (let i = 1; i < reply.length; i += 2) {
        const fields = reply[i + 1]
        const jsonIndex = fields.indexOf('$')
        if (jsonIndex >= 0) documents.push(JSON.parse(fields[jsonIndex + 1]))
    }
    return { total: Number(reply[0]), documents }
}
const command = async (client, mode, uuid, object) => mode === 'string'
    ? client.set(`doc:${uuid}`, JSON.stringify(object))
    : client.sendCommand(['JSON.SET', `doc:${uuid}`, '$', JSON.stringify(object)])
const fetchUuid = async (client, mode, uuid) => {
    const value = mode === 'string' ? await client.get(`doc:${uuid}`) : await client.sendCommand(['JSON.GET', `doc:${uuid}`, '$'])
    if (value === null) return null
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed[0] : parsed
}
async function sustained(client, mode, ids, { durationMs, concurrency, type, pid }) {
    const execute = async sequence => {
        const uuid = ids[(sequence * 7919) % ids.length]
        const write = type === 'write' || type === 'mixed' && sequence % 2 === 1
        const start = performance.now()
        if (write) {
            if (mode === 'json-search') await client.sendCommand(['JSON.NUMINCRBY', `doc:${uuid}`, '$.revision', '1'])
            else {
                const doc = await fetchUuid(client, mode, uuid)
                assert.ok(doc)
                doc.revision++
                await command(client, mode, uuid, doc)
            }
        } else assert.equal((await fetchUuid(client, mode, uuid))?.uuid, uuid)
        return performance.now() - start
    }
    for (let i = 0; i < 10; i++) await execute(i)
    const serverStart = readProcess(pid), clientCpuStart = process.cpuUsage()
    const start = performance.now(), deadline = start + durationMs, latency = []
    const latencySampleLimit = 20000
    let sequence = 10, operations = 0, randomState = 0x6d2b79f5
    while (performance.now() < deadline) {
        const count = Math.min(concurrency, Math.max(1, Math.ceil(deadline - performance.now())))
        const batch = await Promise.all(Array.from({ length: count }, () => execute(sequence++)))
        for (const value of batch) {
            if (latency.length < latencySampleLimit) latency.push(value)
            else {
                randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0
                const index = randomState % operations
                if (index < latencySampleLimit) latency[index] = value
            }
            operations++
        }
    }
    const elapsedMs = performance.now() - start, cpu = process.cpuUsage(clientCpuStart), serverEnd = readProcess(pid)
    const serverCpuMs = serverStart && serverEnd ? (serverEnd.cpuTicks - serverStart.cpuTicks) * 10 : null
    return { mode: type, concurrency, durationTargetMs: durationMs, operations, elapsedMs, opsPerSecond: operations / elapsedMs * 1000,
        latency: stats(latency), latencyReservoirLimit: latencySampleLimit, clientCpuUsageUs: cpu,
        clientCpuUtilizationPercent: (cpu.user + cpu.system) / 1000 / elapsedMs * 100,
        serverCpuMs, serverCpuUtilizationPercent: serverCpuMs === null ? null : serverCpuMs / elapsedMs * 100,
        clientMemory: process.memoryUsage(), serverMemory: readProcess(pid) }
}

async function runOne(size, runIndex, mode, outputFile, settings) {
    const environment = recordEnvironment(), root = lifecycleRoot(size)
    const result = { status: 'running', benchmark: `redis-${mode}-standard-single-node-local-loopback`, benchmarkVersion: 1,
        fixture: 'shared lifecycle fixture v3', fixtureVersion: '3.0.0', runIndex, datasetSize: size, mode,
        sampleCount: settings.samples, warmupCount: settings.warmups, sustainedDurationMs: settings.sustainMs,
        concurrencyLevels: settings.concurrency, environment, sourceRevision: revision(), startedAt: new Date().toISOString(),
        configuration: { deployment: 'single Redis server', version: redisVersion, client: driverVersion,
            storage: mode === 'json-search' ? 'RedisJSON documents with RediSearch JSON index' : 'JSON text stored by Redis String SET/GET',
            durability: 'RDB and AOF disabled', queryLimit: 100, indexSchema: mode === 'json-search' ? schema : [] } }
    const cpuStart = process.cpuUsage(), wallStart = performance.now(), directory = await mkdtemp(join(tmpdir(), 'cocreatedb-redis-bench-'))
    let server, client
    try {
        const serverStart = performance.now()
        server = await startRedis(directory); client = server.client
        result.serverStartupMs = performance.now() - serverStart
        result.serverPid = server.child.pid
        result.serverVersion = await client.info('server').then(info => info.match(/redis_version:([^\r\n]+)/)?.[1])
        assert.equal(result.serverVersion, redisVersion)
        result.serverMemory = { idle: readProcess(result.serverPid) }
        const firstCreateStart = performance.now()
        await command(client, mode, `seed-${runIndex}-${size}`, { uuid: `seed-${runIndex}-${size}`, revision: 0 })
        result.firstObjectCreateMs = performance.now() - firstCreateStart
        if (mode === 'json-search') {
            const indexStart = performance.now()
            await client.sendCommand(['FT.CREATE', 'fixture_idx', 'ON', 'JSON', 'PREFIX', '1', 'doc:', 'SCHEMA', ...schema])
            result.indexSetupMs = performance.now() - indexStart
        } else result.indexSetupMs = 0
        result.clientMemory = { idle: process.memoryUsage() }
        const hash = createHash('sha256'); hash.update('['); let first = true, createAndIndexMs = 0
        const chunkSize = 500
        const reportProgress = createProgressReporter(`redis-${mode}`, size)
        for (let offset = 0; offset < size; offset += chunkSize) {
            const commands = []
            for (let rank = offset; rank < Math.min(size, offset + chunkSize); rank++) {
                const record = createBenchmarkRecord(rank, size, root.organization_id)
                if (!first) hash.update(','); first = false; hash.update(JSON.stringify(record))
                commands.push(command(client, mode, record.uuid, record))
            }
            const started = performance.now()
            await Promise.all(commands)
            createAndIndexMs += performance.now() - started
            reportProgress(Math.min(size, offset + chunkSize))
        }
        hash.update(']')
        result.fixtureHash = hash.digest('hex'); result.createAndIndexMs = createAndIndexMs
        result.createRecordsPerSecond = size / createAndIndexMs * 1000
        result.serverMemory.loaded = readProcess(result.serverPid)
        result.serverMemory.peakRssBytes = result.serverMemory.loaded?.VmHWM ?? null
        result.clientMemory.loaded = process.memoryUsage()
        if (mode === 'json-search') result.indexInfo = await client.sendCommand(['FT.INFO', 'fixture_idx'])
        result.redisMemory = await client.info('memory')
        result.redisKeyCount = await client.dbSize()
        assert.equal(result.redisKeyCount, size + 1)
        const middle = benchmarkUuid(Math.floor(size / 2))
        assert.equal((await fetchUuid(client, mode, middle)).uuid, middle)
        const workload = standardWorkloads(size)
        const expected = {
            equality: expectedIds(size, workload.equality.matches),
            nestedEquality: expectedIds(size, workload.nestedEquality.matches),
            numericRange: expectedIds(size, workload.numericRange.matches),
            and: expectedIds(size, workload.and.matches),
            or: expectedIds(size, workload.or.matches)
        }
        result.operations = {}
        result.operations.uuidRead = await measure(() => fetchUuid(client, mode, middle), value => assert.equal(value?.uuid, middle), settings)
        if (mode === 'json-search') {
            const tag = value => value.replaceAll('-', '\\-')
            const queries = { equality: `@group:{${tag(workload.equality.value)}}`, nestedEquality: `@team:{${tag(workload.nestedEquality.value)}}`,
                numericRange: `@rank:[${workload.numericRange.lower} ${workload.numericRange.upper - 1}]`,
                and: `@group:{${tag(workload.and.group)}} @active:{${workload.and.active}}`,
                or: `(${workload.or.groups.map(group => `@group:{${tag(group)}}`).join('|')})` }
            for (const [name, query] of Object.entries(queries)) {
                const value = await search(client, query)
                assert.equal(value.total, countExpected(size, workload[name].matches), `correctness ${name} count`)
                compareIds(value.documents, expected[name], `correctness ${name}`)
                result.operations[name] = await measure(async () => (await search(client, query)).documents,
                    documents => compareIds(documents, expected[name], name), settings)
            }
        } else result.operations.queryNote = 'Not applicable: Redis String keys have no secondary indexes; see json-search lane.'

        let createRank = size + 1000 + runIndex * (settings.warmups + settings.samples + 100)
        result.operations.singleCreate = await measure(async () => {
            const record = createBenchmarkRecord(createRank++, size, root.organization_id)
            return command(client, mode, record.uuid, record)
        }, value => assert.equal(value, mode === 'string' ? 'OK' : 'OK'), settings)
        let updateRank = 0
        result.operations.singleKeyUpdate = await measure(async (stage, index) => {
            const uuid = benchmarkUuid(updateRank++ % size)
            const note = `note-${stage}-${index}`
            if (mode === 'json-search') return client.sendCommand(['JSON.SET', `doc:${uuid}`, '$.note', JSON.stringify(note)])
            const doc = await fetchUuid(client, mode, uuid)
            doc.note = note
            return command(client, mode, uuid, doc)
        }, value => assert.equal(value, 'OK'), settings)
        let incrementRank = Math.floor(size / 2)
        result.operations.numericIncrement = await measure(async () => {
            const uuid = benchmarkUuid(incrementRank++ % size)
            if (mode === 'json-search') return client.sendCommand(['JSON.NUMINCRBY', `doc:${uuid}`, '$.revision', '1'])
            const doc = await fetchUuid(client, mode, uuid); doc.revision++; return command(client, mode, uuid, doc)
        }, value => assert.ok(value), settings)
        let deleteRank = 0
        result.operations.singleDelete = await measure(async () => {
            const uuid = `delete:${runIndex}:${deleteRank++}`
            await command(client, mode, uuid, { uuid })
            return client.del(`${mode === 'string' ? 'doc:' : 'doc:'}${uuid}`)
        }, value => assert.equal(value, 1), settings)
        if (mode === 'json-search') {
            const bulkQuery = '@bulkDelete:{true}'
            const before = await search(client, bulkQuery)
            const expectedBulkDelete = Math.min(size, 25)
            assert.equal(before.total, expectedBulkDelete)
            const start = performance.now()
            if (before.documents.length) await Promise.all(before.documents.map(doc => client.del(`doc:${doc.uuid}`)))
            result.operations.filteredBulkDelete = { deleted: before.documents.length, elapsedMs: performance.now() - start }
            assert.equal((await search(client, bulkQuery)).total, 0)
        }
        const retained = size - (mode === 'json-search' ? Math.min(size, 25) : 0)
        const ids = Array.from({ length: Math.min(retained, 10000) }, (_, rank) => benchmarkUuid(rank))
        result.sustained = []
        for (const concurrency of settings.concurrency) for (const type of ['read', 'write', 'mixed'])
            result.sustained.push(await sustained(client, mode, ids, { durationMs: settings.sustainMs, concurrency, type, pid: result.serverPid }))
        result.clientCpuUsageUs = process.cpuUsage(cpuStart)
        result.totalElapsedMs = performance.now() - wallStart
        result.clientCpuUtilizationPercent = (result.clientCpuUsageUs.user + result.clientCpuUsageUs.system) / 1000 / result.totalElapsedMs * 100
        const finalProcess = readProcess(result.serverPid), idle = result.serverMemory.idle
        result.serverResourceUsage = { idle, final: finalProcess,
            cpuMs: idle && finalProcess ? (finalProcess.cpuTicks - idle.cpuTicks) * 10 : null,
            cpuUtilizationPercent: idle && finalProcess ? (finalProcess.cpuTicks - idle.cpuTicks) * 10 / result.totalElapsedMs * 100 : null }
        result.clientMemory.final = process.memoryUsage(); result.clientMemory.peakRssBytes = process.resourceUsage().maxRSS * 1024
        result.completedAt = new Date().toISOString(); result.status = 'passed'
        await writeFile(outputFile, `${JSON.stringify(result, null, 2)}\n`)
        return result
    } catch (error) {
        result.status = 'failed'; result.failure = { name: error.name, message: error.message, stack: error.stack }
        result.completedAt = new Date().toISOString(); result.totalElapsedMs = performance.now() - wallStart
        await writeFile(outputFile, `${JSON.stringify(result, null, 2)}\n`)
        return result
    } finally {
        await client?.quit().catch(() => {})
        if (server?.child.exitCode === null) { server.child.kill('SIGTERM'); await new Promise(resolvePromise => server.child.once('exit', resolvePromise)) }
        await rm(directory, { recursive: true, force: true }).catch(() => {})
    }
}
const launch = args => launchChild(args, { cwd: here })
async function orchestrate() {
    const sizes = parseStandardSizes(process.argv[2])
    const runs = Number(process.env.BENCH_RUNS ?? 5), samples = Math.max(40, Number(process.env.BENCH_SAMPLES ?? 40))
    const warmups = Math.max(10, Number(process.env.BENCH_WARMUPS ?? 10)), sustainMs = Math.max(1000, Number(process.env.BENCH_SUSTAIN_MS ?? 5000))
    const concurrency = (process.env.BENCH_CONCURRENCY ?? '1,8').split(',').map(Number)
    const modes = (process.env.REDIS_BENCH_MODES ?? 'string,json-search').split(',')
    const started = new Date(), runId = started.toISOString().replaceAll(':', '-')
    const output = resolve(process.env.BENCH_OUTPUT_DIR ?? join(here, 'results', `standard-${runId}`))
    await mkdir(output, { recursive: true })
    const manifest = { suite: 'Redis comparison benchmark v1', provider: 'Redis', serverVersion: redisVersion, driverVersion,
        runId, startedAt: started.toISOString(), sizes, modes, independentRunsRequested: runs,
        sampleCount: samples, warmupCount: warmups, sustainedDurationMs: sustainMs, concurrencyLevels: concurrency,
        resourcePolicy: 'fresh Redis child process and temporary directory per run; RDB/AOF disabled', results: [] }
    for (const mode of modes) for (const size of sizes) {
        let failed = false
        for (let runIndex = 1; runIndex <= runs; runIndex++) {
            const file = `${mode}-size-${size}-run-${String(runIndex).padStart(2, '0')}.json`, path = join(output, file)
            if (failed) {
                const skipped = { status: 'not-attempted', datasetSize: size, runIndex, mode, reason: 'Earlier run in this lane and size failed.' }
                await writeFile(path, `${JSON.stringify(skipped, null, 2)}\n`); manifest.results.push({ size, runIndex, mode, ...skipped, file }); continue
            }
            const child = await launch([script, '--child', String(size), String(runIndex), mode, path, JSON.stringify({ samples, warmups, sustainMs, concurrency })])
            let raw
            try { raw = JSON.parse(await readFile(path, 'utf8')) } catch {}
            const status = child.code === 0 && raw?.status === 'passed' ? 'passed' : 'failed'
            if (!raw) raw = { status, datasetSize: size, runIndex, mode, failure: { message: 'Redis benchmark child exited without a result', exitCode: child.code, signal: child.signal, stderr: child.stderr } }
            else if (status === 'failed') raw.subprocess = { exitCode: child.code, signal: child.signal, stderr: child.stderr.slice(-3000) }
            await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`)
            manifest.results.push({ size, runIndex, mode, status, file, elapsedMs: raw.totalElapsedMs, failure: raw.failure })
            console.log(`mode=${mode} size=${size} run=${runIndex}/${runs} status=${status}${raw.failure ? ` reason=${raw.failure.message}` : ` create=${raw.createAndIndexMs.toFixed(2)}ms`}`)
            if (status === 'failed') failed = true
        }
    }
    manifest.completedAt = new Date().toISOString()
    manifest.summary = { successfulRuns: manifest.results.filter(run => run.status === 'passed').length,
        failedRuns: manifest.results.filter(run => run.status === 'failed').length,
        notAttempted: manifest.results.filter(run => run.status === 'not-attempted').length }
    await writeFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    console.log(`manifest=${join(output, 'manifest.json')}`)
    console.log(`successful=${manifest.summary.successfulRuns} failed=${manifest.summary.failedRuns} notAttempted=${manifest.summary.notAttempted}`)
    const report = await launch([join(here, 'report.mjs'), output])
    process.stdout.write(report.stdout)
    if (report.code !== 0) { process.stderr.write(report.stderr); process.exitCode = report.code ?? 1 }
}
if (process.argv[2] === '--child') {
    const [size, runIndex, mode, outputFile, settings] = process.argv.slice(3)
    const result = await runOne(Number(size), Number(runIndex), mode, resolve(outputFile), JSON.parse(settings))
    if (result.status !== 'passed') process.exitCode = 1
} else await orchestrate()
