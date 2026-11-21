import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import fs from 'node:fs'
import { availableParallelism, cpus, freemem, release as osRelease, totalmem, version as osVersion } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { benchmarkUuid, createBenchmarkRecord, lifecycleRoot } from '../../../fixtures/lifecycle.mjs'
import { launch as launchChild } from '../../shared/child-process.mjs'
import { createProgressReporter, expectedUuids as getExpectedUuids, parseStandardSizes, standardWorkloads } from '../../shared/workloads.mjs'

const { Pool } = pg
const script = fileURLToPath(import.meta.url)
const here = dirname(script)
const benchmarkRoot = resolve(here, '../..')
const version = '26.3.5'
const cache = process.env.COCKROACH_BENCH_CACHE ?? join(process.env.HOME, '.cache/cocreate-db-cockroach', version)
const binary = join(cache, 'install/cockroach')
const storePath = join(cache, 'store')
const port = Number(process.env.COCKROACH_PORT ?? 26257)
const httpPort = Number(process.env.COCKROACH_HTTP_PORT ?? 28080)
const databaseUrl = process.env.COCKROACH_DATABASE_URL ?? `postgresql://root@127.0.0.1:${port}/defaultdb?sslmode=disable`
const percentile = (values, fraction) => {
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0
}
const stats = values => ({
    samples: values.length, minMs: Math.min(...values), maxMs: Math.max(...values),
    meanMs: values.reduce((sum, value) => sum + value, 0) / values.length,
    p50Ms: percentile(values, .5), p95Ms: percentile(values, .95), p99Ms: percentile(values, .99)
})
const revision = () => {
    try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: benchmarkRoot, encoding: 'utf8' }).trim() }
    catch { return null }
}
const environment = () => ({
    date: new Date().toISOString(), node: process.version, platform: `${process.platform}-${process.arch}`,
    release: osRelease(), os: osVersion(), cpuModel: cpus()[0]?.model, cpuCount: availableParallelism(),
    totalMemoryBytes: totalmem(), freeMemoryBytesAtStart: freemem(), cockroachServerVersion: version,
    pgDriverVersion: JSON.parse(fs.readFileSync(join(here, 'node_modules/pg/package.json'), 'utf8')).version,
    processModel: 'single CockroachDB start-single-node process plus Node pg client over loopback TCP',
    persistence: 'CockroachDB Pebble store in a user-cache directory; fresh SQL database per trial',
    durability: 'single local node, insecure development mode, default transaction durability; no replication or multi-node consensus',
    transactionIsolation: 'CockroachDB default SERIALIZABLE isolation',
    transport: 'PostgreSQL wire protocol over 127.0.0.1 TCP'
})
const delay = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms))
const readProcess = pid => {
    if (!pid || process.platform !== 'linux') return null
    try {
        const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8')
        const fields = Object.fromEntries([...status.matchAll(/^(VmRSS|VmHWM|VmSize):\s+(\d+) kB$/gm)].map(match => [match[1], Number(match[2]) * 1024]))
        const statLine = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
        const counters = statLine.slice(statLine.lastIndexOf(')') + 1).trim().split(/\s+/)
        fields.cpuTicks = Number(counters[11]) + Number(counters[12])
        return fields
    } catch { return null }
}
async function directoryBytes(path) {
    let total = 0
    for (const entry of await readdir(path, { withFileTypes: true })) {
        const fullPath = join(path, entry.name)
        if (entry.isDirectory()) total += await directoryBytes(fullPath)
        else total += (await stat(fullPath)).size
    }
    return total
}
function createPool(database = 'defaultdb', max = 16) {
    const url = new URL(databaseUrl)
    url.pathname = `/${database}`
    return new Pool({ connectionString: url.toString(), max, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000,
        application_name: 'cocreate-db-standard-benchmark' })
}
let serverChild
let serverClose
let serverLog
let adminPool
async function startServer() {
    try {
        const probe = createPool()
        await probe.query('SELECT 1')
        await probe.end()
        throw Error(`CockroachDB port ${port} is already accepting SQL connections; stop it or choose COCKROACH_PORT.`)
    } catch (error) {
        if (error.message.includes('already accepting')) throw error
    }
    await mkdir(join(cache, 'logs'), { recursive: true })
    await mkdir(join(cache, 'tmp'), { recursive: true })
    await rm(storePath, { recursive: true, force: true })
    await mkdir(storePath, { recursive: true })
    serverLog = fs.createWriteStream(join(cache, 'logs/benchmark-server.log'), { flags: 'a' })
    serverChild = spawn(binary, [
        'start-single-node', '--insecure', `--store=${storePath}`,
        `--listen-addr=127.0.0.1:${port}`, `--http-addr=127.0.0.1:${httpPort}`,
        '--cache=512MiB', '--max-sql-memory=512MiB', `--log-dir=${join(cache, 'logs')}`, `--temp-dir=${join(cache, 'tmp')}`
    ], { cwd: cache, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let startupLogs = ''
    for (const stream of [serverChild.stdout, serverChild.stderr]) stream.on('data', chunk => {
        serverLog.write(chunk); startupLogs = (startupLogs + chunk.toString()).slice(-6000)
    })
    serverClose = new Promise(resolvePromise => serverChild.once('close', (code, signal) => resolvePromise({ code, signal })))
    adminPool = createPool()
    const start = performance.now()
    while (performance.now() - start < 90000) {
        if (serverChild.exitCode !== null) throw Error(`CockroachDB exited during startup: ${startupLogs}`)
        try {
            const result = await adminPool.query('SELECT version() AS version')
            const serverVersion = result.rows[0].version
            if (serverVersion.includes(version)) return { elapsedMs: performance.now() - start, serverVersion }
            return { elapsedMs: performance.now() - start, serverVersion }
        } catch {}
        await delay(250)
    }
    throw Error(`CockroachDB did not become ready at 127.0.0.1:${port}: ${startupLogs}`)
}
async function stopServer() {
    await adminPool?.end().catch(() => {})
    if (serverChild && serverChild.exitCode === null) {
        serverChild.kill('SIGTERM')
        await Promise.race([serverClose, delay(20000)])
        if (serverChild.exitCode === null) serverChild.kill('SIGKILL')
    }
    await serverClose?.catch(() => {})
    serverLog?.end()
}

const indexDefinitions = [
    { name: 'group_uuid', columns: 'group_name, uuid' },
    { name: 'profile_team_uuid', columns: 'team, uuid' },
    { name: 'rank_idx', columns: 'rank, uuid' },
    { name: 'group_active_uuid', columns: 'group_name, active, uuid' },
    { name: 'bulk_delete', columns: 'bulk_delete, uuid' }
]
const expectedIds = (size, predicate, limit = 100) => getExpectedUuids(size, predicate, limit)
const verifyDocuments = (documents, expected, label) => assert.deepEqual(documents.map(document => document.uuid), expected, `${label} UUIDs`)
const recordValues = record => [record.uuid, record._id, record.organization_id, record.group, record.active,
    record.rank, record.profile.team, record.bulkDelete, record.revision, JSON.stringify(record)]
async function insertRecords(pool, records) {
    const fields = ['uuid', 'application_id', 'organization_id', 'group_name', 'active', 'rank', 'team', 'bulk_delete', 'revision', 'document']
    const params = []
    const tuples = records.map(record => {
        const offset = params.length
        params.push(...recordValues(record))
        return `(${fields.map((_, index) => `$${offset + index + 1}${index === fields.length - 1 ? '::JSONB' : ''}`).join(', ')})`
    })
    return pool.query(`INSERT INTO documents (${fields.join(', ')}) VALUES ${tuples.join(', ')}`, params)
}
async function measure(operation, validate, { samples, warmups }) {
    let start = performance.now()
    validate(await operation('first', 0))
    const firstOperationMs = performance.now() - start
    for (let index = 0; index < warmups; index++) validate(await operation('warmup', index))
    const values = []
    const runStart = performance.now()
    for (let index = 0; index < samples; index++) {
        start = performance.now()
        const value = await operation('sample', index)
        values.push(performance.now() - start)
        validate(value)
    }
    const elapsedMs = performance.now() - runStart
    return { firstOperationMs, warmups, measured: { ...stats(values), totalMs: elapsedMs, opsPerSecond: values.length / elapsedMs * 1000 } }
}
function sqlFor(query) {
    const hint = query.index ? `@{FORCE_INDEX=${query.index}}` : ''
    return `SELECT document FROM documents${hint} WHERE ${query.where} ORDER BY ${query.order ?? 'uuid'} LIMIT 100`
}
async function queryDocuments(pool, query) {
    const result = await pool.query(sqlFor(query), query.params)
    return result.rows.map(row => row.document)
}
async function runOne(size, runIndex, outputFile, settings) {
    const result = {
        status: 'running', benchmark: 'cockroachdb-standard-single-node-loopback', benchmarkVersion: 1,
        fixture: 'shared lifecycle fixture v3', fixtureVersion: '3.0.0', runIndex, datasetSize: size,
        sampleCount: settings.samples, warmupCount: settings.warmups,
        sustainedDurationMs: settings.sustainMs, concurrencyLevels: settings.concurrency,
        environment: environment(), sourceRevision: revision(), startedAt: new Date().toISOString(),
        configuration: {
            deployment: 'single CockroachDB start-single-node instance', connectionUrl: databaseUrl.replace(/\/[^/?]+(?=\?|$)/, '/<database>'),
            sqlMemoryCap: '512 MiB', cacheCap: '512 MiB', isolation: 'SERIALIZABLE',
            primaryKey: 'uuid', documentStorage: 'JSONB full document plus typed columns used by secondary indexes', indexDefinitions
        }
    }
    const wallStart = performance.now(), clientCpuStart = process.cpuUsage()
    const database = `crdb_bench_${size}_${runIndex}_${Date.now().toString(36)}`
    result.database = database
    const controlPool = createPool()
    const pool = createPool(database)
    try {
        await controlPool.query(`CREATE DATABASE ${database}`)
        const tableStart = performance.now()
        await pool.query(`CREATE TABLE documents (
            uuid STRING PRIMARY KEY,
            application_id STRING NOT NULL,
            organization_id STRING NOT NULL,
            group_name STRING NOT NULL,
            active BOOL NOT NULL,
            rank INT8 NOT NULL,
            team STRING NOT NULL,
            bulk_delete BOOL NOT NULL,
            revision INT8 NOT NULL,
            document JSONB NOT NULL
        )`)
        result.tableSetupMs = performance.now() - tableStart
        const indexStart = performance.now()
        for (const index of indexDefinitions) await pool.query(`CREATE INDEX ${index.name} ON documents (${index.columns})`)
        result.indexSetupMs = performance.now() - indexStart
        result.serverMemory = { idle: readProcess(settings.serverPid) }
        result.clientMemory = { idle: process.memoryUsage() }

        const seed = {
            uuid: `seed-${runIndex}-${size}`, _id: `seed-${runIndex}-${size}`, organization_id: lifecycleRoot(size).organization_id,
            rank: -1, group: 'seed', active: false, createdAt: '2020-01-01T00:00:00.000Z',
            profile: { team: 'seed', score: 0, location: { region: 'seed', verified: false } },
            tags: [], payload: 'seed', bulkDelete: false, revision: 0
        }
        const firstCreateStart = performance.now()
        await insertRecords(pool, [seed])
        result.firstObjectCreateMs = performance.now() - firstCreateStart

        const fixtureHash = createHash('sha256')
        fixtureHash.update('[')
        let firstRecord = true, createAndIndexMs = 0
        const reportProgress = createProgressReporter('cockroachdb', size)
        for (let offset = 0; offset < size; offset += 1000) {
            const records = []
            const end = Math.min(size, offset + 1000)
            for (let rank = offset; rank < end; rank++) {
                const record = createBenchmarkRecord(rank, size, lifecycleRoot(size).organization_id)
                if (!firstRecord) fixtureHash.update(',')
                fixtureHash.update(JSON.stringify(record)); firstRecord = false
                records.push(record)
            }
            const start = performance.now()
            const inserted = await insertRecords(pool, records)
            assert.equal(inserted.rowCount, records.length)
            createAndIndexMs += performance.now() - start
            reportProgress(end)
        }
        fixtureHash.update(']')
        result.fixtureHash = fixtureHash.digest('hex')
        result.createAndIndexMs = createAndIndexMs
        result.createRecordsPerSecond = size / createAndIndexMs * 1000
        result.indexCreationAndMaintenance = { indexSetupMs: result.indexSetupMs, indexesMaintainedDuringIngest: true, indexes: indexDefinitions }
        const count = Number((await pool.query('SELECT count(*) FROM documents')).rows[0].count)
        assert.equal(count, size + 1, 'seed and fixture documents are present')
        const indexRows = (await pool.query('SHOW INDEXES FROM documents')).rows
        result.databaseStats = {
            documentCount: count,
            nodeStoreBytes: await directoryBytes(storePath),
            indexCount: new Set(indexRows.map(row => row.index_name)).size
        }
        result.serverMemory.loaded = readProcess(settings.serverPid)
        result.serverMemory.peakRssBytes = result.serverMemory.loaded?.VmHWM ?? null
        result.clientMemory.loaded = process.memoryUsage()

        const workload = standardWorkloads(size)
        const queries = [
            { key: 'equality', index: 'group_uuid', where: 'group_name = $1', params: [workload.equality.value], expected: expectedIds(size, workload.equality.matches), order: 'uuid' },
            { key: 'nestedEquality', index: 'profile_team_uuid', where: 'team = $1', params: [workload.nestedEquality.value], expected: expectedIds(size, workload.nestedEquality.matches), order: 'uuid' },
            { key: 'numericRange', index: 'rank_idx', where: 'rank >= $1 AND rank < $2', params: [workload.numericRange.lower, workload.numericRange.upper], expected: expectedIds(size, workload.numericRange.matches), order: 'rank, uuid' },
            { key: 'and', index: 'group_active_uuid', where: 'group_name = $1 AND active = $2', params: [workload.and.group, workload.and.active], expected: expectedIds(size, workload.and.matches), order: 'uuid' },
            { key: 'or', index: 'group_uuid', where: 'group_name IN ($1, $2)', params: workload.or.groups, expected: expectedIds(size, workload.or.matches), order: 'uuid' }
        ]
        const middle = benchmarkUuid(Math.floor(size / 2))
        const direct = await pool.query('SELECT document FROM documents WHERE uuid = $1', [middle])
        assert.equal(direct.rows[0]?.document.uuid, middle, 'UUID direct lookup returns full document')
        for (const query of queries) verifyDocuments(await queryDocuments(pool, query), query.expected, query.key)
        result.queryPlans = {}
        for (const query of queries) {
            const plan = await pool.query(`EXPLAIN ${sqlFor(query)}`, query.params)
            result.queryPlans[query.key] = plan.rows.map(row => Object.values(row).join(' | '))
        }

        result.operations = {}
        result.operations.uuidRead = await measure(async () => (await pool.query('SELECT document FROM documents WHERE uuid = $1', [middle])).rows.map(row => row.document),
            docs => { assert.equal(docs.length, 1); assert.equal(docs[0].uuid, middle) }, settings)
        for (const query of queries)
            result.operations[query.key] = await measure(() => queryDocuments(pool, query), docs => verifyDocuments(docs, query.expected, query.key), settings)

        let createRank = size + 1000 + runIndex * (settings.warmups + settings.samples + 100)
        result.operations.singleCreate = await measure(async () => {
            const record = createBenchmarkRecord(createRank++, size, lifecycleRoot(size).organization_id)
            return insertRecords(pool, [record])
        }, value => assert.equal(value.rowCount, 1), settings)

        let updateRank = Math.floor(size / 4)
        result.operations.singleKeyUpdate = await measure(async (stage, index) => pool.query(
            `UPDATE documents SET document = document || jsonb_build_object('note', $1::STRING) WHERE uuid = $2`,
            [`note-${stage}-${index}`, benchmarkUuid(updateRank++)]), value => assert.equal(value.rowCount, 1), settings)
        const indexedStart = Math.floor(size / 3)
        let indexedRank = indexedStart
        result.operations.indexedKeyUpdate = await measure(async (stage, index) => pool.query(
            `UPDATE documents SET group_name = $1, document = document || jsonb_build_object('group', $1::STRING) WHERE uuid = $2`,
            [`updated-group-${stage}-${index}`, benchmarkUuid(indexedRank++)]), value => assert.equal(value.rowCount, 1), settings)
        result.operations.numericIncrement = await measure(async (stage, index) => pool.query(
            `UPDATE documents SET revision = revision + 1, document = document || jsonb_build_object('revision', revision + 1) WHERE uuid = $1`,
            [benchmarkUuid(Math.floor(size / 2) + index)]), value => assert.equal(value.rowCount, 1), settings)
        const lastIndexedRank = indexedStart + settings.warmups + settings.samples
        const indexedCheck = await pool.query(sqlFor({ index: 'group_uuid', where: 'group_name = $1', params: [`updated-group-sample-${settings.samples - 1}`], order: 'uuid' }), [`updated-group-sample-${settings.samples - 1}`])
        assert.equal(indexedCheck.rows[0]?.document.uuid, benchmarkUuid(lastIndexedRank), 'indexed update appears under its new value')

        const deleteStart = size + 5000 + runIndex * (settings.warmups + settings.samples + 100)
        const deleteIds = []
        const deleteRecords = []
        for (let index = 0; index < settings.warmups + settings.samples + 1; index++) {
            const record = createBenchmarkRecord(deleteStart + index, size, lifecycleRoot(size).organization_id)
            deleteIds.push(record.uuid); deleteRecords.push(record)
        }
        await insertRecords(pool, deleteRecords)
        let deleteIndex = 0
        result.operations.singleDelete = await measure(async () => pool.query('DELETE FROM documents WHERE uuid = $1', [deleteIds[deleteIndex++]]),
            value => assert.equal(value.rowCount, 1), settings)
        assert.equal(Number((await pool.query('SELECT count(*) FROM documents WHERE uuid = ANY($1::STRING[])', [deleteIds])).rows[0].count), 0)

        const bulkCount = Number((await pool.query('SELECT count(*) FROM documents WHERE bulk_delete = true')).rows[0].count)
        const expectedBulkDelete = Math.min(size, 25)
        assert.equal(bulkCount, expectedBulkDelete)
        const bulkStart = performance.now()
        const bulkDelete = await pool.query('DELETE FROM documents WHERE bulk_delete = true')
        const bulkDeleteMs = performance.now() - bulkStart
        assert.equal(bulkDelete.rowCount, expectedBulkDelete)
        assert.equal(Number((await pool.query('SELECT count(*) FROM documents WHERE bulk_delete = true')).rows[0].count), 0)
        result.operations.filteredBulkDelete = { deleted: expectedBulkDelete, elapsedMs: bulkDeleteMs, opsPerSecond: expectedBulkDelete / bulkDeleteMs * 1000 }

        const sustainedIds = Array.from({ length: Math.min(size - expectedBulkDelete, 10000) }, (_, rank) => benchmarkUuid(rank))
        const sustained = async (mode, concurrency) => {
            let sequence = 0
            const execute = async number => {
                const uuid = sustainedIds[(number * 7919) % sustainedIds.length]
                const write = mode === 'write' || mode === 'mixed' && number % 2 === 1
                const start = performance.now()
                if (write) {
                    const result = await pool.query(`UPDATE documents SET revision = revision + 1, document = document || jsonb_build_object('revision', revision + 1) WHERE uuid = $1`, [uuid])
                    assert.equal(result.rowCount, 1)
                } else {
                    const result = await pool.query('SELECT document FROM documents WHERE uuid = $1', [uuid])
                    assert.equal(result.rows[0]?.document.uuid, uuid)
                }
                return performance.now() - start
            }
            for (let warm = 0; warm < 10; warm++) await execute(sequence++)
            const serverStart = readProcess(settings.serverPid)
            const clientCpu = process.cpuUsage()
            const start = performance.now(), deadline = start + settings.sustainMs
            let operations = 0
            const latencies = []
            while (performance.now() < deadline) {
                const batch = await Promise.all(Array.from({ length: concurrency }, () => execute(sequence++)))
                latencies.push(...batch); operations += batch.length
            }
            const elapsedMs = performance.now() - start
            const usage = process.cpuUsage(clientCpu)
            const serverEnd = readProcess(settings.serverPid)
            const serverCpuMs = serverStart && serverEnd ? (serverEnd.cpuTicks - serverStart.cpuTicks) * 10 : null
            return {
                mode, concurrency, durationTargetMs: settings.sustainMs, operations, elapsedMs,
                opsPerSecond: operations / elapsedMs * 1000, latency: stats(latencies),
                clientCpuUtilizationPercent: (usage.user + usage.system) / 1000 / elapsedMs * 100,
                serverCpuUtilizationPercent: serverCpuMs === null ? null : serverCpuMs / elapsedMs * 100,
                clientMemory: process.memoryUsage(), serverMemory: serverEnd
            }
        }
        result.sustained = []
        for (const concurrency of settings.concurrency) for (const mode of ['read', 'write', 'mixed'])
            result.sustained.push(await sustained(mode, concurrency))

        result.databaseStatsFinal = {
            documentCount: Number((await pool.query('SELECT count(*) FROM documents')).rows[0].count),
            nodeStoreBytes: await directoryBytes(storePath)
        }
        result.clientCpuUsageUs = process.cpuUsage(clientCpuStart)
        result.totalElapsedMs = performance.now() - wallStart
        result.clientMemory.final = process.memoryUsage()
        result.clientMemory.peakRssBytes = process.resourceUsage().maxRSS * 1024
        result.serverResourceUsage = { start: result.serverMemory.idle, final: readProcess(settings.serverPid) }
        result.completedAt = new Date().toISOString()
        result.status = 'passed'
    } catch (error) {
        result.status = 'failed'
        result.failure = { name: error.name, message: error.message, stack: error.stack }
        result.completedAt = new Date().toISOString()
        result.totalElapsedMs = performance.now() - wallStart
    } finally {
        await pool.end().catch(() => {})
        await controlPool.query(`DROP DATABASE IF EXISTS ${database} CASCADE`).catch(error => { result.cleanupError = error.message })
        await controlPool.end().catch(() => {})
        await writeFile(outputFile, `${JSON.stringify(result, null, 2)}\n`)
    }
    return result
}
const launch = args => launchChild(args, { cwd: here })
async function orchestrate() {
    const sizes = parseStandardSizes(process.argv[2])
    const runs = Number(process.env.BENCH_RUNS ?? 5)
    const samples = Math.max(40, Number(process.env.BENCH_SAMPLES ?? 40))
    const warmups = Math.max(10, Number(process.env.BENCH_WARMUPS ?? 10))
    const sustainMs = Math.max(1000, Number(process.env.BENCH_SUSTAIN_MS ?? 5000))
    const concurrency = (process.env.BENCH_CONCURRENCY ?? '1,8').split(',').map(Number)
    const started = new Date(), runId = started.toISOString().replaceAll(':', '-')
    const output = resolve(process.env.BENCH_OUTPUT_DIR ?? join(here, 'results', `standard-${runId}`))
    await mkdir(output, { recursive: true })
    const manifest = {
        suite: 'CockroachDB comparison benchmark v1', provider: 'CockroachDB', serverVersion: version,
        driverVersion: environment().pgDriverVersion, runId, startedAt: started.toISOString(), sizes,
        independentRunsRequested: runs, sampleCount: samples, warmupCount: warmups,
        sustainedDurationMs: sustainMs, concurrencyLevels: concurrency,
        resourcePolicy: 'single isolated CockroachDB process; fresh SQL database per independent trial; server stops after suite', results: []
    }
    try {
        const startup = await startServer()
        manifest.serverStartupMs = startup.elapsedMs
        manifest.serverVersionReported = startup.serverVersion
        manifest.storePath = storePath
        console.log(`cockroachdb=${version} startup=${startup.elapsedMs.toFixed(0)}ms`)
        for (const size of sizes) {
            let failed = false
            for (let runIndex = 1; runIndex <= runs; runIndex++) {
                const file = `size-${size}-run-${String(runIndex).padStart(2, '0')}.json`
                const path = join(output, file)
                if (failed) {
                    const skipped = { status: 'not-attempted', datasetSize: size, runIndex, reason: 'Earlier independent run at this size failed.' }
                    await writeFile(path, `${JSON.stringify(skipped, null, 2)}\n`)
                    manifest.results.push({ size, runIndex, ...skipped, file }); continue
                }
                const child = await launch([script, '--child', String(size), String(runIndex), path,
                    JSON.stringify({ samples, warmups, sustainMs, concurrency, serverPid: serverChild.pid })])
                let raw
                try { raw = JSON.parse(await readFile(path, 'utf8')) } catch {}
                const status = child.code === 0 && raw?.status === 'passed' ? 'passed' : 'failed'
                if (!raw) raw = { status, datasetSize: size, runIndex, failure: { message: 'Benchmark child exited before writing a result', exitCode: child.code, signal: child.signal, stderr: child.stderr } }
                else if (status === 'failed') raw.subprocess = { exitCode: child.code, signal: child.signal, stderr: child.stderr.slice(-4000) }
                await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`)
                manifest.results.push({ size, runIndex, status, file, elapsedMs: raw.totalElapsedMs, failure: raw.failure })
                console.log(`size=${size} run=${runIndex}/${runs} status=${status}${raw.failure ? ` reason=${raw.failure.message}` : ` create+index=${raw.createAndIndexMs.toFixed(2)}ms`}`)
                if (status === 'failed') failed = true
            }
        }
    } catch (error) {
        manifest.startupFailure = { name: error.name, message: error.message, stack: error.stack }
    } finally {
        await stopServer().catch(error => { manifest.stopFailure = error.message })
    }
    manifest.completedAt = new Date().toISOString()
    manifest.summary = { successfulRuns: manifest.results.filter(run => run.status === 'passed').length,
        failedRuns: manifest.results.filter(run => run.status === 'failed').length,
        notAttempted: manifest.results.filter(run => run.status === 'not-attempted').length }
    manifest.serverStoppedAfterSuite = !serverChild || serverChild.exitCode !== null
    await writeFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    console.log(`manifest=${join(output, 'manifest.json')}`)
    console.log(`successful=${manifest.summary.successfulRuns} failed=${manifest.summary.failedRuns} notAttempted=${manifest.summary.notAttempted}`)
    const report = await launch([join(here, 'report.mjs'), output])
    process.stdout.write(report.stdout)
    if (report.code !== 0) { process.stderr.write(report.stderr); process.exitCode = report.code ?? 1 }
    if (manifest.startupFailure) process.exitCode = 1
}

if (process.argv[2] === '--child') {
    const [size, runIndex, outputFile, settings] = process.argv.slice(3)
    const result = await runOne(Number(size), Number(runIndex), resolve(outputFile), JSON.parse(settings))
    if (result.status !== 'passed') process.exitCode = 1
} else await orchestrate()
