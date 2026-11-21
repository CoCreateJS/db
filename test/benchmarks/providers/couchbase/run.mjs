import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import fs from 'node:fs'
import { availableParallelism, cpus, freemem, release as osRelease, totalmem, version as osVersion } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { benchmarkUuid, createBenchmarkRecord, lifecycleRoot } from '../../../fixtures/lifecycle.mjs'
import { launch as launchChild } from '../../shared/child-process.mjs'
import { createProgressReporter, expectedUuids as getExpectedUuids, parseStandardSizes, standardWorkloads } from '../../shared/workloads.mjs'
delete process.env.ELECTRON_RUN_AS_NODE
const { default: couchbase } = await import('couchbase')

const script = fileURLToPath(import.meta.url)
const here = dirname(script)
const benchmarkRoot = resolve(here, '../..')
const serverVersion = '8.0.2'
const driverVersion = JSON.parse(await readFile(join(here, 'node_modules/couchbase/package.json'), 'utf8')).version
const serverInstall = process.env.COUCHBASE_INSTALL_DIR ?? join(process.env.HOME, '.cache/cocreate-db-couchbase/8.0.2-nonroot/install/opt/couchbase')
const endpoint = process.env.COUCHBASE_URL ?? 'couchbase://127.0.0.1'
const username = process.env.COUCHBASE_USERNAME ?? 'Administrator'
const password = process.env.COUCHBASE_PASSWORD ?? 'CouchbaseBench123!'
const adminUrl = process.env.COUCHBASE_ADMIN_URL ?? 'http://127.0.0.1:8091'
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
    totalMemoryBytes: totalmem(), freeMemoryBytesAtStart: freemem(), serverVersion, driverVersion,
    processModel: 'single-node Couchbase Server plus Node SDK over loopback TCP',
    persistence: 'Couchbase Couchstore bucket on local filesystem; benchmark bucket deleted after each run',
    durability: 'single node, replicaNumber=0, default SDK durability (none), no transactions',
    transport: 'Couchbase binary KV and SQL++ query protocols over loopback TCP'
})
const readProcess = pid => {
    if (!pid || process.platform !== 'linux') return null
    try {
        const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8')
        const fields = Object.fromEntries([...status.matchAll(/^(VmRSS|VmHWM|VmSize):\s+(\d+) kB$/gm)].map(m => [m[1], Number(m[2]) * 1024]))
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
        const counters = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)
        fields.cpuTicks = Number(counters[11]) + Number(counters[12])
        return fields
    } catch { return null }
}
const serverProcesses = () => {
    if (process.platform !== 'linux') return []
    const rows = []
    for (const name of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) continue
        try {
            const executable = fs.readlinkSync(`/proc/${name}/exe`)
            if (executable.startsWith(`${serverInstall}/`)) {
                const data = readProcess(Number(name))
                if (data) rows.push({ pid: Number(name), ...data })
            }
        } catch {}
    }
    return rows
}
const processTotals = () => {
    const rows = serverProcesses()
    return {
        processes: rows.length,
        rssBytes: rows.reduce((sum, row) => sum + (row.VmRSS ?? 0), 0),
        peakRssBytes: rows.reduce((sum, row) => sum + (row.VmHWM ?? 0), 0),
        cpuTicks: rows.reduce((sum, row) => sum + (row.cpuTicks ?? 0), 0)
    }
}
const delay = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms))
const request = async (path, options = {}) => {
    const response = await fetch(`${adminUrl}${path}`, {
        ...options,
        headers: { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`, ...options.headers }
    })
    const text = await response.text()
    if (!response.ok && response.status !== 404) throw Error(`Couchbase admin ${options.method ?? 'GET'} ${path}: ${response.status} ${text}`)
    return { response, text }
}
async function waitForAdmin() {
    const start = performance.now()
    while (performance.now() - start < 15000) {
        try {
            const response = await fetch(`${adminUrl}/pools`)
            if (response.status === 200 || response.status === 401) return
        } catch {}
        await delay(200)
    }
    throw Error(`Couchbase admin API is unavailable at ${adminUrl}`)
}
async function bucketCreate(name) {
    const body = new URLSearchParams({ name, bucketType: 'couchbase', ramQuotaMB: '512', flushEnabled: '1', replicaNumber: '0' })
    const { response, text } = await request('/pools/default/buckets', { method: 'POST', body })
    if (response.status !== 202) throw Error(`Bucket create returned ${response.status}: ${text}`)
    const start = performance.now()
    while (performance.now() - start < 30000) {
        const check = await request(`/pools/default/buckets/${name}`)
        if (check.response.ok) {
            const bucket = JSON.parse(check.text)
            if (bucket.vBucketServerMap?.serverList?.length && bucket.nodes?.every(node => node.status === 'healthy')) return
        }
        await delay(200)
    }
    throw Error(`Bucket ${name} did not become ready`)
}
async function bucketDelete(name) {
    const { response } = await request(`/pools/default/buckets/${name}`, { method: 'DELETE' })
    if (response.status !== 200 && response.status !== 404) throw Error(`Bucket delete returned ${response.status}`)
}
const quote = value => `\`${value.replaceAll('`', '``')}\``
const expectedIds = (size, predicate, limit = 100) => getExpectedUuids(size, predicate, limit)
const verifyIds = (documents, expected, label) => assert.deepEqual(documents.map(document => document.uuid), expected, `${label} result UUIDs`)
async function measure(operation, validate, { samples, warmups }) {
    let before = performance.now()
    validate(await operation('first', 0))
    const firstOperationMs = performance.now() - before
    for (let index = 0; index < warmups; index++) validate(await operation('warmup', index))
    const values = []
    const start = performance.now()
    for (let index = 0; index < samples; index++) {
        before = performance.now()
        const result = await operation('sample', index)
        values.push(performance.now() - before)
        validate(result)
    }
    const elapsedMs = performance.now() - start
    return { firstOperationMs, warmups, measured: { ...stats(values), totalMs: elapsedMs, opsPerSecond: values.length / elapsedMs * 1000 } }
}
async function sustained(collection, ids, settings, mode, concurrency, processStart) {
    const execute = async sequence => {
        const write = mode === 'write' || mode === 'mixed' && sequence % 2 === 1
        const start = performance.now()
        if (write) await collection.mutateIn(ids[(sequence * 7919) % ids.length], [couchbase.MutateInSpec.increment('revision', 1)])
        else await collection.get(ids[(sequence * 7919) % ids.length])
        return performance.now() - start
    }
    for (let i = 0; i < 10; i++) await execute(i)
    const clientCpuStart = process.cpuUsage()
    const start = performance.now(), deadline = start + settings.sustainMs
    const latency = []
    let sequence = 10, operations = 0
    while (performance.now() < deadline) {
        const batch = await Promise.all(Array.from({ length: concurrency }, () => execute(sequence++)))
        latency.push(...batch)
        operations += batch.length
    }
    const elapsedMs = performance.now() - start
    const processEnd = processTotals()
    const clientCpuUsageUs = process.cpuUsage(clientCpuStart)
    const cpuMs = processEnd.cpuTicks >= processStart.cpuTicks ? (processEnd.cpuTicks - processStart.cpuTicks) * 10 : null
    return {
        mode, concurrency, durationTargetMs: settings.sustainMs, operations, elapsedMs,
        opsPerSecond: operations / elapsedMs * 1000, latency: stats(latency), serverCpuMs: cpuMs,
        serverCpuUtilizationPercent: cpuMs === null ? null : cpuMs / elapsedMs * 100,
        clientCpuUsageUs,
        clientCpuUtilizationPercent: (clientCpuUsageUs.user + clientCpuUsageUs.system) / 1000 / elapsedMs * 100,
        clientMemory: process.memoryUsage(), serverMemory: processEnd
    }
}

async function runOne(size, runIndex, outputFile, settings) {
    const result = {
        status: 'running', benchmark: 'couchbase-standard-single-node-loopback', benchmarkVersion: 1,
        fixture: 'shared lifecycle fixture v3', fixtureVersion: '3.0.0', runIndex, datasetSize: size,
        sampleCount: settings.samples, warmupCount: settings.warmups,
        sustainedDurationMs: settings.sustainMs, concurrencyLevels: settings.concurrency,
        environment: environment(), sourceRevision: revision(), startedAt: new Date().toISOString(),
        configuration: {
            deployment: 'single local Couchbase Community node', storageBackend: 'couchstore', bucketQuotaMiB: 512,
            replicaNumber: 0, durability: 'none', maxParallelBulkOps: 1000,
            indexDefinitions: ['group+uuid', 'profile.team+uuid', 'rank', 'group+active+uuid', 'bulkDelete'],
            uuidLookup: 'Couchbase document key equals record.uuid; KV Get does not use a secondary index'
        }
    }
    const cpuStart = process.cpuUsage(), wallStart = performance.now()
    const bucketName = `cdb${String(size).slice(-6)}${runIndex}${Date.now().toString(36).slice(-5)}`.slice(0, 20)
    result.bucketName = bucketName
    let cluster
    try {
        await waitForAdmin()
        const startupStart = performance.now()
        const pools = await fetch(`${adminUrl}/pools`)
        if (pools.status === 401) {
            const authenticated = await request('/pools')
            if (!authenticated.response.ok) throw Error(`Couchbase authentication failed: ${authenticated.response.status}`)
        }
        result.readinessMs = performance.now() - startupStart
        const versionInfo = await request('/pools/default')
        result.couchbaseServerVersion = JSON.parse(versionInfo.text).nodes[0]?.version
        const indexSettings = await request('/settings/indexes')
        result.indexStorageMode = JSON.parse(indexSettings.text).storageMode
        if (result.indexStorageMode !== 'forestdb')
            throw Error(`Couchbase Community benchmark requires index storage mode forestdb; found ${result.indexStorageMode}`)
        const serverStart = processTotals()
        result.serverMemory = { idle: serverStart }
        await bucketCreate(bucketName)
        cluster = await couchbase.Cluster.connect(endpoint, { username, password, configProfile: 'wanDevelopment' })
        const bucket = cluster.bucket(bucketName)
        await bucket.collections().createRoot('bench_root')
        await bucket.collections().createCollection('records', 'bench_root')
        const root = bucket.root('bench_root')
        const collection = root.collection('records')
        const bucketKey = quote(bucketName), rootKey = quote('bench_root'), collectionKey = quote('records')
        const fq = `${bucketKey}.${rootKey}.${collectionKey}`
        const indexStart = performance.now()
        const indexStatements = [
            `CREATE INDEX group_uuid ON ${fq}(` + '`group`' + `, uuid)`,
            `CREATE INDEX profile_team_uuid ON ${fq}(profile.team, uuid)`,
            `CREATE INDEX rank_idx ON ${fq}(rank)`,
            `CREATE INDEX group_active_uuid ON ${fq}(` + '`group`' + `, active, uuid)`,
            `CREATE INDEX bulk_delete ON ${fq}(bulkDelete)`
        ]
        for (const statement of indexStatements) await cluster.query(statement)
        result.indexSetupMs = performance.now() - indexStart
        const indexReadyStart = performance.now()
        let indexesReady = false
        while (performance.now() - indexReadyStart < 60000) {
            const indexes = await cluster.query(`SELECT name, state FROM system:indexes WHERE keyspace_id = 'records' AND bucket_id = '${bucketName}' AND root_id = 'bench_root'`)
            indexesReady = indexes.rows.length === indexStatements.length && indexes.rows.every(row => row.state === 'online')
            if (indexesReady) break
            await delay(250)
        }
        result.indexReadyMs = performance.now() - indexReadyStart
        assert.ok(indexesReady, `Couchbase GSI indexes not online after ${result.indexReadyMs.toFixed(0)} ms`)
        const seed = { uuid: `seed-${runIndex}-${size}`, _id: `seed-${runIndex}-${size}`, rank: -1,
            group: 'seed', active: false, createdAt: '2020-01-01T00:00:00.000Z',
            profile: { team: 'seed', score: 0, location: { region: 'seed', verified: false } },
            tags: [], payload: 'seed', bulkDelete: false, revision: 0 }
        const firstStart = performance.now()
        await collection.insert(seed.uuid, seed)
        result.firstObjectCreateMs = performance.now() - firstStart
        const fixtureHash = createHash('sha256')
        fixtureHash.update('[')
        let first = true, createAndIndexMs = 0
        const reportProgress = createProgressReporter('couchbase', size)
        for (let offset = 0; offset < size; offset += 1000) {
            const end = Math.min(size, offset + 1000)
            const operations = []
            for (let rank = offset; rank < end; rank++) {
                const record = createBenchmarkRecord(rank, size, lifecycleRoot(size).organization_id)
                if (!first) fixtureHash.update(',')
                fixtureHash.update(JSON.stringify(record)); first = false
                operations.push({ key: record.uuid, value: record })
            }
            const start = performance.now()
            const results = await Promise.all(operations.map(({ key, value }) => collection.insert(key, value)))
            assert.equal(results.length, end - offset)
            createAndIndexMs += performance.now() - start
            reportProgress(end)
        }
        fixtureHash.update(']')
        result.fixtureHash = fixtureHash.digest('hex')
        result.createAndIndexMs = createAndIndexMs
        result.createRecordsPerSecond = size / createAndIndexMs * 1000
        result.indexCreationAndMaintenance = { indexSetupMs: result.indexSetupMs, indexReadyMs: result.indexReadyMs,
            incrementalMaintainedDuringInsert: true, definitions: indexStatements }
        const clientMemoryIdle = process.memoryUsage()
        const bucketStats = await request(`/pools/default/buckets/${bucketName}`)
        result.databaseStats = JSON.parse(bucketStats.text).basicStats
        const serverAfterLoad = processTotals()
        result.serverMemory.loaded = serverAfterLoad
        result.serverMemory.peakRssBytes = serverAfterLoad.peakRssBytes
        result.clientMemory = { idle: clientMemoryIdle, loaded: process.memoryUsage() }

        const catchupStart = performance.now()
        let visibleCount = 0
        while (performance.now() - catchupStart < 30000) {
            const catchup = await cluster.query(`SELECT RAW COUNT(1) FROM ${fq} USE INDEX (group_uuid)`, {
                scanConsistency: couchbase.QueryScanConsistency.RequestPlus
            })
            visibleCount = catchup.rows[0]
            if (visibleCount === size + 1) break
            await delay(100)
        }
        result.indexCatchupMs = performance.now() - catchupStart
        assert.equal(visibleCount, size + 1, 'Couchbase Query Service catches up to all seeded documents')

        const query = async (condition, order = 'r.uuid', limit = 100) => {
            const response = await cluster.query(`SELECT r.* FROM ${fq} AS r WHERE ${condition} ORDER BY ${order} LIMIT ${limit}`, {
                scanConsistency: couchbase.QueryScanConsistency.NotBounded
            })
            return response.rows
        }
        const workload = standardWorkloads(size)
        const queries = [
            { key: 'equality', condition: 'r.`group` = $v', parameters: { v: workload.equality.value }, order: 'r.uuid', expected: expectedIds(size, workload.equality.matches) },
            { key: 'nestedEquality', condition: 'r.profile.team = $v', parameters: { v: workload.nestedEquality.value }, order: 'r.uuid', expected: expectedIds(size, workload.nestedEquality.matches) },
            { key: 'numericRange', condition: 'r.rank >= $lo AND r.rank < $hi', parameters: { lo: workload.numericRange.lower, hi: workload.numericRange.upper }, order: 'r.rank', expected: expectedIds(size, workload.numericRange.matches) },
            { key: 'and', condition: 'r.`group` = $g AND r.active = $active', parameters: { g: workload.and.group, active: workload.and.active }, order: 'r.uuid', expected: expectedIds(size, workload.and.matches) },
            { key: 'or', condition: '(r.`group` = $a OR r.`group` = $b)', parameters: { a: workload.or.groups[0], b: workload.or.groups[1] }, order: 'r.uuid', expected: expectedIds(size, workload.or.matches) }
        ]
        const runQuery = item => cluster.query(`SELECT r.* FROM ${fq} AS r WHERE ${item.condition} ORDER BY ${item.order} LIMIT 100`, {
            parameters: item.parameters, scanConsistency: couchbase.QueryScanConsistency.NotBounded
        }).then(response => response.rows)
        const uuidDoc = await collection.get(benchmarkUuid(Math.floor(size / 2)))
        assert.equal(uuidDoc.content.uuid, benchmarkUuid(Math.floor(size / 2)))
        for (const item of queries) verifyIds(await runQuery(item), item.expected, item.key)
        result.queryPlans = {}
        for (const item of queries) {
            const explain = await cluster.query(`EXPLAIN SELECT r.* FROM ${fq} AS r WHERE ${item.condition} ORDER BY ${item.order} LIMIT 100`, { parameters: item.parameters })
            result.queryPlans[item.key] = explain.rows
        }
        result.operations = {}
        result.operations.uuidRead = await measure(() => collection.get(benchmarkUuid(Math.floor(size / 2))).then(result => [result.content]), docs => {
            assert.equal(docs[0].uuid, benchmarkUuid(Math.floor(size / 2)))
        }, settings)
        for (const item of queries) result.operations[item.key] = await measure(() => runQuery(item), docs => verifyIds(docs, item.expected, item.key), settings)
        let createRank = size + 1000 + runIndex * (settings.warmups + settings.samples + 100)
        result.operations.singleCreate = await measure(async () => {
            const record = createBenchmarkRecord(createRank++, size, lifecycleRoot(size).organization_id)
            return collection.insert(record.uuid, record)
        }, response => assert.ok(response.cas), settings)
        let updateRank = 0
        result.operations.singleKeyUpdate = await measure((stage, index) => collection.mutateIn(benchmarkUuid(updateRank++), [
            couchbase.MutateInSpec.upsert('note', `note-${stage}-${index}`)
        ]), response => assert.ok(response.cas), settings)
        const indexedStart = Math.floor(size / 3)
        let indexedRank = indexedStart
        result.operations.indexedKeyUpdate = await measure((stage, index) => collection.mutateIn(benchmarkUuid(indexedRank++), [
            couchbase.MutateInSpec.upsert('group', `updated-group-${stage}-${index}`)
        ]), response => assert.ok(response.cas), settings)
        result.operations.numericIncrement = await measure((stage, index) => collection.mutateIn(benchmarkUuid(Math.floor(size / 2) + index), [
            couchbase.MutateInSpec.increment('revision', 1)
        ]), response => assert.ok(response.cas), settings)
        const deleteOffset = size + 5000 + runIndex * (settings.warmups + settings.samples + 100)
        const deleteIds = []
        for (let i = 0; i < settings.warmups + settings.samples + 1; i++) {
            const record = createBenchmarkRecord(deleteOffset + i, size, lifecycleRoot(size).organization_id)
            deleteIds.push(record.uuid)
            await collection.insert(record.uuid, record)
        }
        let deleteIndex = 0
        result.operations.singleDelete = await measure(() => collection.remove(deleteIds[deleteIndex++]), response => assert.ok(response.cas), settings)
        const bulkDeleteStart = performance.now()
        const deleted = await cluster.query(`DELETE FROM ${fq} AS r WHERE r.bulkDelete = TRUE RETURNING META(r).id`)
        const expectedBulkDelete = Math.min(size, 25)
        assert.equal(deleted.rows.length, expectedBulkDelete)
        result.operations.filteredBulkDelete = { deleted: deleted.rows.length, elapsedMs: performance.now() - bulkDeleteStart }
        const sustainedIds = Array.from({ length: Math.min(size - expectedBulkDelete, 10000) }, (_, rank) => benchmarkUuid(rank))
        result.sustained = []
        for (const concurrency of settings.concurrency) for (const mode of ['read', 'write', 'mixed']) {
            const start = processTotals()
            result.sustained.push(await sustained(collection, sustainedIds, settings, mode, concurrency, start))
        }
        result.clientCpuUsageUs = process.cpuUsage(cpuStart)
        result.totalElapsedMs = performance.now() - wallStart
        result.clientMemory.final = process.memoryUsage()
        result.clientMemory.peakRssBytes = process.resourceUsage().maxRSS * 1024
        const finalStats = await request(`/pools/default/buckets/${bucketName}`)
        result.databaseStatsFinal = JSON.parse(finalStats.text).basicStats
        result.serverResourceUsage = { idle: result.serverMemory.idle, final: processTotals() }
        result.completedAt = new Date().toISOString()
        result.status = 'passed'
    } catch (error) {
        result.status = 'failed'
        result.failure = { name: error.name, message: error.message, context: error.context?.toJSON?.() ?? error.context, stack: error.stack }
        result.completedAt = new Date().toISOString()
        result.totalElapsedMs = performance.now() - wallStart
    } finally {
        await cluster?.close().catch(() => {})
        if (!(result.status === 'failed' && process.env.COUCHBASE_KEEP_BUCKET_ON_FAILURE === '1'))
            await bucketDelete(bucketName).catch(error => { result.cleanupError = error.message })
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
    const manifest = { suite: 'Couchbase comparison benchmark v1', provider: 'Couchbase', serverVersion, driverVersion,
        runId, startedAt: started.toISOString(), sizes, independentRunsRequested: runs, sampleCount: samples,
        warmupCount: warmups, sustainedDurationMs: sustainMs, concurrencyLevels: concurrency,
        resourcePolicy: 'one persistent local Couchbase server; fresh bucket per independent run; 512 MiB bucket quota; no replicas', results: [] }
    for (const size of sizes) {
        let failed = false
        for (let runIndex = 1; runIndex <= runs; runIndex++) {
            const file = `size-${size}-run-${String(runIndex).padStart(2, '0')}.json`, path = join(output, file)
            if (failed) {
                const skipped = { status: 'not-attempted', datasetSize: size, runIndex, reason: 'Earlier independent run at this size failed.' }
                await writeFile(path, `${JSON.stringify(skipped, null, 2)}\n`)
                manifest.results.push({ size, runIndex, ...skipped, file }); continue
            }
            const child = await launch([script, '--child', String(size), String(runIndex), path,
                JSON.stringify({ samples, warmups, sustainMs, concurrency })])
            let raw
            try { raw = JSON.parse(await readFile(path, 'utf8')) } catch {}
            const status = child.code === 0 && raw?.status === 'passed' ? 'passed' : 'failed'
            if (!raw) raw = { status, datasetSize: size, runIndex, failure: { message: 'Couchbase child exited without a result', exitCode: child.code, signal: child.signal, stderr: child.stderr } }
            else if (status === 'failed') raw.subprocess = { exitCode: child.code, signal: child.signal, stderr: child.stderr.slice(-3000) }
            await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`)
            manifest.results.push({ size, runIndex, status, file, elapsedMs: raw.totalElapsedMs, failure: raw.failure })
            console.log(`size=${size} run=${runIndex}/${runs} status=${status}${raw.failure ? ` reason=${raw.failure.message}` : ` create+index=${raw.createAndIndexMs.toFixed(2)}ms`}`)
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
    const [size, runIndex, outputFile, settings] = process.argv.slice(3)
    const result = await runOne(Number(size), Number(runIndex), resolve(outputFile), JSON.parse(settings))
    if (result.status !== 'passed') process.exitCode = 1
} else await orchestrate()
