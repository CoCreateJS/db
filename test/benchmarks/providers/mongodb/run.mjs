import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { availableParallelism, cpus, freemem, release as osRelease, tmpdir, totalmem, version as osVersion } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MongoClient } from 'mongodb'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { benchmarkUuid, createBenchmarkRecord, lifecycleRoot } from '../../../fixtures/lifecycle.mjs'
import { launch as launchChild } from '../../shared/child-process.mjs'
import { createProgressReporter, expectedUuids as getExpectedUuids, parseStandardSizes, standardWorkloads } from '../../shared/workloads.mjs'

const script = fileURLToPath(import.meta.url)
const here = dirname(script)
const benchmarkRoot = resolve(here, '../..')
const serverVersion = '9.0.8'
const driverVersion = JSON.parse(await readFile(join(here, 'node_modules/mongodb/package.json'), 'utf8')).version
const percentile = (values, fraction) => {
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0
}
const stats = (values, elapsedMs) => ({
    samples: values.length,
    minMs: Math.min(...values),
    maxMs: Math.max(...values),
    meanMs: values.reduce((sum, value) => sum + value, 0) / values.length,
    p50Ms: percentile(values, 0.50),
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99),
    ...(elapsedMs === undefined ? {} : { totalMs: elapsedMs, opsPerSecond: values.length / elapsedMs * 1000 })
})
const recordEnvironment = () => {
    let memoryLimitBytes
    for (const file of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
        try {
            const value = readFileSync(file)
            if (value !== 'max' && Number.isFinite(Number(value))) memoryLimitBytes = Number(value)
            break
        } catch {}
    }
    return {
        date: new Date().toISOString(), node: process.version,
        platform: `${process.platform}-${process.arch}`, release: osRelease(), os: osVersion(),
        cpuModel: cpus()[0]?.model, cpuCount: availableParallelism(),
        totalMemoryBytes: totalmem(), freeMemoryBytesAtStart: freemem(), memoryLimitBytes,
        mongoServerVersion: serverVersion, mongoNodeDriverVersion: driverVersion,
        processModel: 'MongoDB mongod child process plus Node driver client over loopback TCP',
        persistence: 'WiredTiger temporary dbPath on local filesystem; removed after each independent run',
        durability: 'standalone; writeConcern w:1,j:false; no replication or transactions',
        readPreference: 'primary', readConcern: 'local',
        transport: 'MongoDB wire protocol over 127.0.0.1 TCP; client and server process costs reported separately',
        diskUsageBytes: 'measured from temporary dbPath before cleanup', diskIO: null
    }
}
function readFileSync(path) {
    return fs.readFileSync(path, 'utf8').trim()
}
const fs = await import('node:fs')
function revision() {
    try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: benchmarkRoot, encoding: 'utf8' }).trim() }
    catch { return null }
}
const median = values => {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
    if (!sorted.length) return null
    const mid = sorted.length >> 1
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
const expectedIds = (size, predicate, limit = 100) => getExpectedUuids(size, predicate, limit)
const verifyIds = (documents, expected, label) => {
    assert.deepEqual(documents.map(document => document.uuid), expected, `${label} result UUIDs`)
}
async function measure(operation, validate, { samples, warmups }) {
    const firstStart = performance.now()
    validate(await operation('first', 0))
    const firstOperationMs = performance.now() - firstStart
    for (let index = 0; index < warmups; index++) validate(await operation('warmup', index))
    const samplesMs = []
    const start = performance.now()
    for (let index = 0; index < samples; index++) {
        const before = performance.now()
        const value = await operation('sample', index)
        const elapsed = performance.now() - before
        validate(value)
        samplesMs.push(elapsed)
    }
    return { firstOperationMs, warmups, measured: stats(samplesMs, performance.now() - start) }
}
function readProcess(pid) {
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
        const entryPath = join(path, entry.name)
        if (entry.isDirectory()) total += await directoryBytes(entryPath)
        else total += (await stat(entryPath)).size
    }
    return total
}

const indexDefinitions = [
    [{ uuid: 1 }, { unique: true, name: 'uuid_unique' }],
    [{ group: 1, uuid: 1 }, { name: 'group_uuid' }],
    [{ 'profile.team': 1, uuid: 1 }, { name: 'profile_team_uuid' }],
    [{ rank: 1 }, { name: 'rank' }],
    [{ group: 1, active: 1, uuid: 1 }, { name: 'group_active_uuid' }],
    [{ bulkDelete: 1 }, { name: 'bulk_delete' }],
    [{ organization_id: 1 }, { name: 'organization_id' }],
    [{ createdAt: 1 }, { name: 'created_at' }],
    [{ 'profile.score': 1 }, { name: 'profile_score' }],
    [{ 'profile.location.region': 1 }, { name: 'profile_location_region' }],
    [{ 'profile.location.verified': 1 }, { name: 'profile_location_verified' }],
    [{ payload: 1 }, { name: 'payload' }],
    [{ revision: 1 }, { name: 'revision' }],
    [{ 'tags.0': 1 }, { name: 'tags_0' }],
    [{ 'tags.1': 1 }, { name: 'tags_1' }]
]

async function sustained(collection, ids, { durationMs, concurrency, mode, pid }) {
    const choose = sequence => ids[(sequence * 7919) % ids.length]
    const execute = async sequence => {
        const write = mode === 'write' || mode === 'mixed' && sequence % 2 === 1
        const before = performance.now()
        let response
        if (write) response = await collection.updateOne({ uuid: choose(sequence) }, { $inc: { revision: 1 } })
        else response = await collection.find({ uuid: choose(sequence) }).limit(1).toArray()
        const elapsed = performance.now() - before
        if (write) assert.equal(response.matchedCount, 1)
        else assert.equal(response.length, 1)
        return elapsed
    }
    for (let index = 0; index < 10; index++) await execute(index)
    const serverStart = readProcess(pid)
    const cpuStart = process.cpuUsage()
    const start = performance.now()
    const deadline = start + durationMs
    const latency = []
    const maxLatencySample = 20000
    let random = 0x6d2b79f5
    let sequence = 10
    let operations = 0
    while (performance.now() < deadline) {
        const count = Math.min(concurrency, Math.max(1, Math.ceil(deadline - performance.now())))
        const batch = await Promise.all(Array.from({ length: count }, () => execute(sequence++)))
        for (const value of batch) {
            if (latency.length < maxLatencySample) latency.push(value)
            else {
                random = (Math.imul(random, 1664525) + 1013904223) >>> 0
                const index = random % operations
                if (index < maxLatencySample) latency[index] = value
            }
        }
        operations += batch.length
    }
    const elapsedMs = performance.now() - start
    const cpu = process.cpuUsage(cpuStart)
    const serverEnd = readProcess(pid)
    const serverCpuMs = serverStart && serverEnd ? (serverEnd.cpuTicks - serverStart.cpuTicks) * 10 : null
    return {
        mode, concurrency, durationTargetMs: durationMs, operations, elapsedMs,
        opsPerSecond: operations / elapsedMs * 1000, latency: stats(latency),
        latencyReservoirLimit: maxLatencySample, clientCpuUsageUs: cpu,
        clientCpuUtilizationPercent: (cpu.user + cpu.system) / 1000 / elapsedMs * 100,
        serverCpuMs, serverCpuUtilizationPercent: serverCpuMs === null ? null : serverCpuMs / elapsedMs * 100,
        clientMemory: process.memoryUsage(), serverMemory: readProcess(sustained.pid)
    }
}

async function runOne(size, runIndex, outputFile, settings) {
    const environment = recordEnvironment()
    const root = lifecycleRoot(size)
    const result = {
        status: 'running', benchmark: 'mongodb-standard-single-node-local-loopback', benchmarkVersion: 1,
        fixture: 'shared lifecycle fixture v3', fixtureVersion: '3.0.0', runIndex, datasetSize: size,
        sampleCount: settings.samples, warmupCount: settings.warmups,
        sustainedDurationMs: settings.sustainMs, concurrencyLevels: settings.concurrency,
        environment, sourceRevision: revision(),
        configuration: {
            deployment: 'single standalone mongod', storageEngine: 'wiredTiger', wiredTigerCacheSizeGB: 1,
            writeConcern: { w: 1, j: false }, readPreference: 'primary', readConcern: 'local',
            indexDefinitions: indexDefinitions.map(([key, options]) => ({ key, ...options })), chunkSize: 1000,
            maxPoolSize: 16, retryWrites: false
        }, startedAt: new Date().toISOString()
    }
    const clientCpuStart = process.cpuUsage()
    const wallStart = performance.now()
    const dbPath = await mkdtemp(join(tmpdir(), 'cocreatedb-mongodb-bench-'))
    let server, client
    try {
        const serverStart = performance.now()
        server = await MongoMemoryServer.create({
            binary: { version: serverVersion },
            instance: { dbPath, storageEngine: 'wiredTiger', args: ['--wiredTigerCacheSizeGB', '1'] }
        })
        result.serverStartupMs = performance.now() - serverStart
        const uri = server.getUri()
        client = new MongoClient(uri, { maxPoolSize: 16, retryWrites: false, readPreference: 'primary' })
        const connectStart = performance.now()
        await client.connect()
        const mongo = client.db(`cocreatedb_bench_${size}_${runIndex}`, { readConcern: { level: 'local' }, writeConcern: { w: 1, j: false } })
        const collection = mongo.collection('records')
        await mongo.command({ ping: 1 })
        result.readinessMs = performance.now() - connectStart
        result.mongoServerVersion = (await mongo.admin().command({ buildInfo: 1 })).version
        assert.equal(result.mongoServerVersion, serverVersion)
        result.serverPid = server.instanceInfo.instance.mongodProcess.pid
        result.serverMemory = { idle: readProcess(result.serverPid) }
        const indexStart = performance.now()
        await collection.createIndexes(indexDefinitions.map(([key, options]) => ({ key, ...options })))
        result.indexSetupMs = performance.now() - indexStart
        const clientMemoryIdle = process.memoryUsage()
        const seed = {
            uuid: `seed-${runIndex}-${size}`, _id: `seed-${runIndex}-${size}`,
            rank: -1, group: 'seed', active: false, createdAt: '2020-01-01T00:00:00.000Z',
            profile: { team: 'seed', score: 0, location: { region: 'seed', verified: false } },
            tags: [], payload: 'seed', bulkDelete: false, revision: 0
        }
        const firstCreateStart = performance.now()
        await collection.insertOne(seed)
        result.firstObjectCreateMs = performance.now() - firstCreateStart

        const fixtureHash = createHash('sha256')
        fixtureHash.update('[')
        let firstRecord = true
        let createAndIndexMs = 0
        const chunkSize = 1000
        const reportProgress = createProgressReporter('mongodb', size)
        for (let offset = 0; offset < size; offset += chunkSize) {
            const records = []
            const end = Math.min(size, offset + chunkSize)
            for (let rank = offset; rank < end; rank++) {
                const record = createBenchmarkRecord(rank, size, root.organization_id)
                if (!firstRecord) fixtureHash.update(',')
                fixtureHash.update(JSON.stringify(record))
                firstRecord = false
                records.push(record)
            }
            const createStart = performance.now()
            await collection.insertMany(records, { ordered: true })
            createAndIndexMs += performance.now() - createStart
            reportProgress(end)
        }
        fixtureHash.update(']')
        result.fixtureHash = fixtureHash.digest('hex')
        result.createAndIndexMs = createAndIndexMs
        result.createRecordsPerSecond = size / createAndIndexMs * 1000
        result.indexCreationAndMaintenance = {
            indexSetupMs: result.indexSetupMs, incrementalMaintainedDuringInsert: true,
            indexes: await collection.indexes()
        }
        result.databaseStats = await mongo.command({ dbStats: 1, scale: 1 })
        const serverStatus = await mongo.admin().command({ serverStatus: 1 })
        result.storageEngineStats = {
            engine: serverStatus.storageEngine?.name,
            cache: serverStatus.wiredTiger?.cache
        }
        const serverAfterLoad = readProcess(result.serverPid)
        result.serverMemory.loaded = serverAfterLoad
        result.serverMemory.peakRssBytes = serverAfterLoad?.VmHWM ?? null
        result.serverMemory.databasePathBytes = await directoryBytes(dbPath)
        result.clientMemory = { idle: clientMemoryIdle, loaded: process.memoryUsage() }

        const find = (query, sort = { uuid: 1 }, limit = 100) => collection.find(query).sort(sort).limit(limit).toArray()
        const workload = standardWorkloads(size)
        const queries = [
            { key: 'equality', query: { group: workload.equality.value }, expected: expectedIds(size, workload.equality.matches), sort: { uuid: 1 } },
            { key: 'nestedEquality', query: { 'profile.team': workload.nestedEquality.value }, expected: expectedIds(size, workload.nestedEquality.matches), sort: { uuid: 1 } },
            { key: 'numericRange', query: { rank: { $gte: workload.numericRange.lower, $lt: workload.numericRange.upper } }, expected: expectedIds(size, workload.numericRange.matches), sort: { rank: 1 } },
            { key: 'and', query: { group: workload.and.group, active: workload.and.active }, expected: expectedIds(size, workload.and.matches), sort: { uuid: 1 } },
            { key: 'or', query: { $or: workload.or.groups.map(group => ({ group })) }, expected: expectedIds(size, workload.or.matches), sort: { uuid: 1 } }
        ]
        verifyIds(await find({ uuid: benchmarkUuid(Math.floor(size / 2)) }), [benchmarkUuid(Math.floor(size / 2))], 'correctness UUID lookup')
        for (const query of queries) verifyIds(await find(query.query, query.sort), query.expected, `correctness ${query.key}`)
        result.queryPlans = {}
        for (const query of queries) {
            const explain = await collection.find(query.query).sort(query.sort).limit(100).explain('executionStats')
            result.queryPlans[query.key] = {
                winningPlan: explain.queryPlanner.winningPlan,
                nReturned: explain.executionStats.nReturned,
                totalKeysExamined: explain.executionStats.totalKeysExamined,
                totalDocsExamined: explain.executionStats.totalDocsExamined
            }
        }

        result.operations = {}
        result.operations.uuidRead = await measure(() => collection.find({ uuid: benchmarkUuid(Math.floor(size / 2)) }).limit(1).toArray(), documents => {
            assert.equal(documents.length, 1)
            assert.equal(documents[0].uuid, benchmarkUuid(Math.floor(size / 2)))
        }, settings)
        for (const query of queries) result.operations[query.key] = await measure(
            () => find(query.query, query.sort), documents => verifyIds(documents, query.expected, query.key), settings)

        let createRank = size + 1000 + runIndex * (settings.warmups + settings.samples + 100)
        result.operations.singleCreate = await measure(() => collection.insertOne(createBenchmarkRecord(createRank++, size, root.organization_id)), value => assert.equal(value.insertedId != null, true), settings)

        let updateRank = Math.floor(size / 4)
        result.operations.singleKeyUpdate = await measure((stage, index) => collection.updateOne(
            { uuid: benchmarkUuid(updateRank++) }, { $set: { note: `note-${stage}-${index}` } }), value => assert.equal(value.matchedCount, 1), settings)
        const indexedStart = Math.floor(size / 3)
        let indexedRank = indexedStart
        result.operations.indexedKeyUpdate = await measure((stage, index) => collection.updateOne(
            { uuid: benchmarkUuid(indexedRank++) }, { $set: { group: `updated-group-${stage}-${index}` } }), value => assert.equal(value.matchedCount, 1), settings)
        result.operations.numericIncrement = await measure((stage, index) => collection.updateOne(
            { uuid: benchmarkUuid(Math.floor(size / 2) + index) }, { $inc: { revision: 1 } }), value => assert.equal(value.matchedCount, 1), settings)
        const lastIndexedRank = indexedStart + settings.warmups + settings.samples
        assert.equal((await find({ group: `updated-group-sample-${settings.samples - 1}` }, { uuid: 1 }, 1))[0]?.uuid, benchmarkUuid(lastIndexedRank))

        const deleteOffset = size + 5000 + runIndex * (settings.warmups + settings.samples + 100)
        const deleteIds = []
        const deleteRecords = []
        for (let index = 0; index < settings.warmups + settings.samples + 1; index++) {
            const record = createBenchmarkRecord(deleteOffset + index, size, root.organization_id)
            deleteIds.push(record.uuid)
            deleteRecords.push(record)
        }
        await collection.insertMany(deleteRecords, { ordered: true })
        let deleteIndex = 0
        result.operations.singleDelete = await measure(() => collection.deleteOne({ uuid: deleteIds[deleteIndex++] }), value => assert.equal(value.deletedCount, 1), settings)
        assert.equal(await collection.countDocuments({ uuid: { $in: deleteIds } }), 0)

        const bulkPrecheck = await collection.countDocuments({ bulkDelete: true })
        const expectedBulkDelete = Math.min(size, 25)
        assert.equal(bulkPrecheck, expectedBulkDelete)
        const bulkDeleteStart = performance.now()
        const bulkDeleted = await collection.deleteMany({ bulkDelete: true })
        const filteredBulkDeleteMs = performance.now() - bulkDeleteStart
        assert.equal(bulkDeleted.deletedCount, expectedBulkDelete)
        assert.equal(await collection.countDocuments({ bulkDelete: true }), 0)
        result.operations.filteredBulkDelete = { deleted: expectedBulkDelete, elapsedMs: filteredBulkDeleteMs, opsPerSecond: expectedBulkDelete / filteredBulkDeleteMs * 1000 }

        const sustainedIds = Array.from({ length: Math.min(size - expectedBulkDelete, 10000) }, (_, rank) => benchmarkUuid(rank))
        result.sustained = []
        for (const concurrency of settings.concurrency)
            for (const mode of ['read', 'write', 'mixed'])
                result.sustained.push(await sustained(collection, sustainedIds, { durationMs: settings.sustainMs, concurrency, mode, pid: result.serverPid }))

        result.clientCpuUsageUs = process.cpuUsage(clientCpuStart)
        result.totalElapsedMs = performance.now() - wallStart
        result.clientCpuUtilizationPercent = (result.clientCpuUsageUs.user + result.clientCpuUsageUs.system) / 1000 / result.totalElapsedMs * 100
        const serverEnd = readProcess(result.serverPid)
        const serverStartTicks = result.serverMemory.idle?.cpuTicks
        result.serverResourceUsage = {
            idle: result.serverMemory.idle, final: serverEnd,
            cpuMs: serverStartTicks !== undefined && serverEnd ? (serverEnd.cpuTicks - serverStartTicks) * 10 : null,
            cpuUtilizationPercent: serverStartTicks !== undefined && serverEnd ? (serverEnd.cpuTicks - serverStartTicks) * 10 / result.totalElapsedMs * 100 : null
        }
        result.clientMemory.final = process.memoryUsage()
        result.clientMemory.peakRssBytes = process.resourceUsage().maxRSS * 1024
        result.completedAt = new Date().toISOString()
        result.status = 'passed'
        await writeFile(outputFile, `${JSON.stringify(result, null, 2)}\n`)
        return result
    } catch (error) {
        result.status = 'failed'
        result.failure = { name: error.name, message: error.message, stack: error.stack }
        result.completedAt = new Date().toISOString()
        result.totalElapsedMs = performance.now() - wallStart
        result.clientCpuUsageUs = process.cpuUsage(clientCpuStart)
        await writeFile(outputFile, `${JSON.stringify(result, null, 2)}\n`)
        return result
    } finally {
        await client?.close().catch(() => {})
        await server?.stop().catch(() => {})
        await rm(dbPath, { recursive: true, force: true }).catch(() => {})
    }
}

const launch = args => launchChild(args, { cwd: here })

async function orchestrate() {
    const sizes = parseStandardSizes(process.argv[2])
    const runs = Number(process.env.BENCH_RUNS ?? 5)
    const samples = Math.max(40, Number(process.env.BENCH_SAMPLES ?? 40))
    const warmups = Math.max(10, Number(process.env.BENCH_WARMUPS ?? 10))
    const sustainMs = Math.max(1000, Number(process.env.BENCH_SUSTAIN_MS ?? 5000))
    const concurrency = (process.env.BENCH_CONCURRENCY ?? '1,8').split(',').map(Number)
    if (!sizes.length || sizes.some(size => !Number.isSafeInteger(size) || size < 1)) throw Error('Dataset sizes must be positive integers')
    const started = new Date()
    const runId = started.toISOString().replaceAll(':', '-')
    const output = resolve(process.env.BENCH_OUTPUT_DIR ?? join(here, 'results', `standard-${runId}`))
    await mkdir(output, { recursive: true })
    const manifest = {
        suite: 'MongoDB comparison benchmark v1', provider: 'MongoDB', serverVersion,
        driverVersion, runId, startedAt: started.toISOString(), sizes,
        independentRunsRequested: runs, sampleCount: samples, warmupCount: warmups,
        sustainedDurationMs: sustainMs, concurrencyLevels: concurrency,
        resourcePolicy: 'fresh single mongod child and temporary dbPath per run; WiredTiger cache capped at 1 GiB',
        results: []
    }
    const binaryPrepareStart = performance.now()
    const preparedServer = await MongoMemoryServer.create({
        binary: { version: serverVersion },
        instance: { storageEngine: 'wiredTiger', args: ['--wiredTigerCacheSizeGB', '1'] }
    })
    await preparedServer.stop()
    manifest.binaryPreparationMs = performance.now() - binaryPrepareStart
    manifest.mongoBinaryPrepared = true
    console.log(`mongodb=${serverVersion} binaryPrepared=${manifest.binaryPreparationMs.toFixed(0)}ms`)
    for (const size of sizes) {
        let failed = false
        for (let runIndex = 1; runIndex <= runs; runIndex++) {
            const file = `size-${size}-run-${String(runIndex).padStart(2, '0')}.json`
            const path = join(output, file)
            if (failed) {
                const skipped = { status: 'not-attempted', datasetSize: size, runIndex, reason: 'Earlier independent run at this size failed.' }
                await writeFile(path, `${JSON.stringify(skipped, null, 2)}\n`)
                manifest.results.push({ size, runIndex, ...skipped, file })
                continue
            }
            const child = await launch([script, '--child', String(size), String(runIndex), path, JSON.stringify({ samples, warmups, sustainMs, concurrency })])
            let raw
            try { raw = JSON.parse(await readFile(path, 'utf8')) } catch {}
            const status = child.code === 0 && raw?.status === 'passed' ? 'passed' : 'failed'
            if (!raw) {
                raw = { status, datasetSize: size, runIndex, environment: recordEnvironment(), failure: {
                    message: 'MongoDB benchmark child exited before writing its result', signal: child.signal,
                    exitCode: child.code, stderr: child.stderr
                } }
                await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`)
            } else if (status === 'failed') {
                raw.subprocess = { exitCode: child.code, signal: child.signal, stderr: child.stderr.slice(-3000) }
                await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`)
            }
            manifest.results.push({ size, runIndex, status, file, elapsedMs: raw.totalElapsedMs, failure: raw.failure })
            console.log(`size=${size} run=${runIndex}/${runs} status=${status}${raw.failure ? ` reason=${raw.failure.message}` : ` create+index=${raw.createAndIndexMs.toFixed(2)}ms`}`)
            if (status === 'failed') failed = true
        }
    }
    manifest.completedAt = new Date().toISOString()
    manifest.summary = {
        successfulRuns: manifest.results.filter(run => run.status === 'passed').length,
        failedRuns: manifest.results.filter(run => run.status === 'failed').length,
        notAttempted: manifest.results.filter(run => run.status === 'not-attempted').length
    }
    await writeFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    console.log(`manifest=${join(output, 'manifest.json')}`)
    console.log(`successful=${manifest.summary.successfulRuns} failed=${manifest.summary.failedRuns} notAttempted=${manifest.summary.notAttempted}`)
    const report = await launch([join(here, 'report.mjs'), output])
    process.stdout.write(report.stdout)
    if (report.code !== 0) {
        process.stderr.write(report.stderr)
        process.exitCode = report.code ?? 1
    }
}

if (process.argv[2] === '--child') {
    const size = Number(process.argv[3]), runIndex = Number(process.argv[4]), outputFile = resolve(process.argv[5])
    const settings = JSON.parse(process.argv[6])
    const result = await runOne(size, runIndex, outputFile, settings)
    if (result.status !== 'passed') process.exitCode = 1
} else {
    await orchestrate()
}
