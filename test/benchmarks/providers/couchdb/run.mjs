import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import fs from 'node:fs'
import { availableParallelism, cpus, freemem, release as osRelease, totalmem, version as osVersion } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { benchmarkUuid, createBenchmarkRecord, lifecycleRoot } from '../../../fixtures/lifecycle.mjs'
import { launch as launchChild } from '../../shared/child-process.mjs'
import { createProgressReporter, expectedUuids as getExpectedUuids, parseStandardSizes, standardWorkloads } from '../../shared/workloads.mjs'

const script = fileURLToPath(import.meta.url)
const here = dirname(script)
const benchmarkRoot = resolve(here, '../..')
const couchdbVersion = '3.5.3'
const cache = process.env.COUCHDB_BENCH_CACHE ?? join(process.env.HOME, '.cache/cocreate-db-couchdb', couchdbVersion)
const root = join(cache, 'rootfs/opt/couchdb')
const install = join(root, 'bin/couchdb')
const dependencyPath = join(cache, 'deps/usr/lib/x86_64-linux-gnu')
const username = process.env.COUCHDB_USERNAME ?? 'benchadmin'
const password = process.env.COUCHDB_PASSWORD ?? 'BenchOnlyCouchDB123!'
const endpoint = process.env.COUCHDB_URL ?? `http://127.0.0.1:${Number(process.env.COUCHDB_PORT ?? 5984)}`
const port = new URL(endpoint).port || '5984'
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
    totalMemoryBytes: totalmem(), freeMemoryBytesAtStart: freemem(), couchdbServerVersion: couchdbVersion,
    processModel: 'single CouchDB server plus Node fetch client over loopback HTTP',
    persistence: 'CouchDB database files under a user-cache directory; fresh database per trial',
    durability: 'single standalone node; CouchDB default commit behavior; no replication or transactions',
    transport: 'HTTP/1.1 JSON API over 127.0.0.1 loopback'
})
const delay = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms))
const readProcess = pid => {
    if (!pid || process.platform !== 'linux') return null
    try {
        const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8')
        const fields = Object.fromEntries([...status.matchAll(/^(VmRSS|VmHWM|VmSize):\s+(\d+) kB$/gm)].map(m => [m[1], Number(m[2]) * 1024]))
        const statLine = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
        const counters = statLine.slice(statLine.lastIndexOf(')') + 1).trim().split(/\s+/)
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
            if (!executable.startsWith(`${root}/`)) continue
            const processStats = readProcess(Number(name))
            if (processStats) rows.push({ pid: Number(name), executable, ...processStats })
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
const basicAuth = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
async function request(path, { method = 'GET', body, allow = [] } = {}) {
    const response = await fetch(`${endpoint}${path}`, {
        method,
        headers: { authorization: basicAuth, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    const text = await response.text()
    let json
    try { json = text ? JSON.parse(text) : null } catch {}
    if (!response.ok && !allow.includes(response.status))
        throw Error(`CouchDB ${method} ${path}: HTTP ${response.status}: ${text.slice(0, 1200)}`)
    return { status: response.status, json, text }
}
const dbPath = (database, suffix = '') => `/${encodeURIComponent(database)}${suffix}`
const systemDbs = ['_users', '_replicator', '_global_changes']
let serverChild
let serverClose
let epmdBefore = new Set()
async function startServer() {
    if (!await exists(install)) throw Error(`Run npm run benchmark --prefix test/benchmarks/providers/couchdb to prepare CouchDB at ${install}`)
    const before = await fetch(endpoint).then(() => true).catch(() => false)
    if (before) throw Error(`CouchDB benchmark port ${port} is already in use. Stop it or set COUCHDB_PORT/COUCHDB_URL to a free local port.`)
    epmdBefore = new Set(serverProcesses().filter(item => item.executable.endsWith('/epmd')).map(item => item.pid))
    const customIni = join(cache, 'local.ini')
    const logPath = join(cache, 'log/couchdb.log')
    await mkdir(dirname(logPath), { recursive: true })
    const log = fs.createWriteStream(join(cache, 'log/benchmark-server.log'), { flags: 'a' })
    serverChild = spawn(install, [], {
        cwd: root,
        env: {
            ...process.env,
            LD_LIBRARY_PATH: [dependencyPath, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'),
            COUCHDB_ARGS_FILE: join(root, 'etc/vm.args'),
            COUCHDB_INI_FILES: [join(root, 'etc/default.ini'), join(root, 'etc/default.d/10-filelog.ini'), customIni].join(' ')
        },
        stdio: ['ignore', 'pipe', 'pipe']
    })
    let startupLogs = ''
    serverChild.stdout.on('data', chunk => { log.write(chunk); startupLogs = (startupLogs + chunk.toString()).slice(-6000) })
    serverChild.stderr.on('data', chunk => { log.write(chunk); startupLogs = (startupLogs + chunk.toString()).slice(-6000) })
    serverClose = new Promise(resolvePromise => serverChild.once('close', (code, signal) => resolvePromise({ code, signal })))
    const start = performance.now()
    while (performance.now() - start < 30000) {
        if (serverChild.exitCode !== null) throw Error(`CouchDB exited during startup: ${startupLogs}`)
        try {
            const response = await request('/')
            if (response.json?.couchdb === 'Welcome') return { elapsedMs: performance.now() - start, version: response.json.version }
        } catch {}
        await delay(200)
    }
    throw Error(`CouchDB did not start at ${endpoint}: ${startupLogs}`)
}
async function initializeServer() {
    for (const name of systemDbs) {
        const result = await request(`/${name}`, { method: 'PUT', allow: [412] })
        if (result.status !== 201 && result.status !== 202 && result.status !== 412)
            throw Error(`Could not initialize CouchDB system database ${name}`)
    }
    return { systemDatabases: systemDbs }
}
async function stopServer() {
    if (serverChild && serverChild.exitCode === null) {
        serverChild.kill('SIGTERM')
        await Promise.race([serverClose, delay(15000)])
        if (serverChild.exitCode === null) serverChild.kill('SIGKILL')
    }
    if (serverChild) await serverClose?.catch(() => {})
    const ownEpmd = serverProcesses().filter(item => item.executable.endsWith('/epmd') && !epmdBefore.has(item.pid))
    for (const item of ownEpmd) try { process.kill(item.pid, 'SIGTERM') } catch {}
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
const expectedIds = (size, predicate, limit = 100) => getExpectedUuids(size, predicate, limit)
const verifyIds = (docs, expected, label) => assert.deepEqual(docs.map(doc => doc.uuid), expected, `${label} UUIDs`)
const percentileStats = values => ({
    samples: values.length, minMs: Math.min(...values), maxMs: Math.max(...values),
    meanMs: values.reduce((sum, value) => sum + value, 0) / values.length,
    p50Ms: percentile(values, .5), p95Ms: percentile(values, .95), p99Ms: percentile(values, .99)
})
async function measure(operation, validate, { samples, warmups }) {
    let start = performance.now()
    validate(await operation('first', 0))
    const firstOperationMs = performance.now() - start
    for (let i = 0; i < warmups; i++) validate(await operation('warmup', i))
    const values = []
    const runStart = performance.now()
    for (let i = 0; i < samples; i++) {
        start = performance.now()
        const value = await operation('sample', i)
        values.push(performance.now() - start)
        validate(value)
    }
    const elapsedMs = performance.now() - runStart
    return { firstOperationMs, warmups, measured: { ...percentileStats(values), totalMs: elapsedMs, opsPerSecond: values.length / elapsedMs * 1000 } }
}

async function createIndex(database, index) {
    const created = await request(dbPath(database, '/_index'), {
        method: 'POST', body: { ddoc: `bench_${index.name}`, name: index.name, type: 'json', index: { fields: index.fields } }
    })
    return { ...index, ddoc: String(created.json.id).replace(/^_design\//, ''), name: created.json.name }
}
const queryBody = (index, selector, sort = [{ uuid: 'asc' }], limit = 100, fields = ['uuid', '_id']) => ({
    selector, ...(sort ? { sort } : {}), limit, fields,
    ...(index ? { use_index: [index.ddoc, index.name], allow_fallback: false } : {}), execution_stats: true
})
async function findDocs(database, index, selector, sort, limit = 100, fields) {
    const result = await request(dbPath(database, '/_find'), { method: 'POST', body: queryBody(index, selector, sort, limit, fields) })
    if (result.json.warning && index) throw Error(`CouchDB Mango did not use ${index.name}: ${result.json.warning}`)
    return result.json
}
const databaseDoc = record => {
    const { _id: applicationId, ...data } = record
    return { ...data, _id: record.uuid, appId: applicationId }
}
const bodyToApp = doc => ({ ...doc, _id: doc.appId })

const indexDefinitions = [
    { name: 'group_uuid', fields: ['group', 'uuid'] },
    { name: 'profile_team_uuid', fields: ['profile.team', 'uuid'] },
    { name: 'rank_idx', fields: ['rank'] },
    { name: 'group_active_uuid', fields: ['group', 'active', 'uuid'] },
    { name: 'bulk_delete', fields: ['bulkDelete'] },
    { name: 'fixture_uuid', fields: ['uuid'] }
]

async function sustained(database, ids, settings, mode, concurrency, serverStart) {
    let sequence = 10
    const execute = async number => {
        const uuid = ids[(number * 7919) % ids.length]
        const write = mode === 'write' || mode === 'mixed' && number % 2 === 1
        const start = performance.now()
        if (write) {
            const doc = (await request(dbPath(database, `/${uuid}`))).json
            doc.revision++
            await request(dbPath(database, `/${uuid}`), { method: 'PUT', body: doc })
        } else await request(dbPath(database, `/${uuid}`))
        return performance.now() - start
    }
    for (let i = 0; i < 10; i++) await execute(i)
    const clientCpuStart = process.cpuUsage()
    const startTime = performance.now(), deadline = startTime + settings.sustainMs
    const latencies = []
    let operations = 0
    while (performance.now() < deadline) {
        const batch = await Promise.all(Array.from({ length: concurrency }, () => execute(sequence++)))
        latencies.push(...batch)
        operations += batch.length
    }
    const elapsedMs = performance.now() - startTime
    const serverEnd = processTotals()
    const clientCpu = process.cpuUsage(clientCpuStart)
    const cpuMs = serverEnd.cpuTicks >= serverStart.cpuTicks ? (serverEnd.cpuTicks - serverStart.cpuTicks) * 10 : null
    return {
        mode, concurrency, durationTargetMs: settings.sustainMs, operations, elapsedMs,
        opsPerSecond: operations / elapsedMs * 1000, latency: percentileStats(latencies),
        clientCpuUtilizationPercent: (clientCpu.user + clientCpu.system) / 1000 / elapsedMs * 100,
        serverCpuUtilizationPercent: cpuMs === null ? null : cpuMs / elapsedMs * 100,
        clientMemory: process.memoryUsage(), serverMemory: serverEnd
    }
}

async function runOne(size, runIndex, outputFile, settings) {
    const result = {
        status: 'running', benchmark: 'couchdb-mango-standard-single-node-loopback', benchmarkVersion: 1,
        fixture: 'shared lifecycle fixture v3', fixtureVersion: '3.0.0', runIndex, datasetSize: size,
        sampleCount: settings.samples, warmupCount: settings.warmups,
        sustainedDurationMs: settings.sustainMs, concurrencyLevels: settings.concurrency,
        environment: environment(), sourceRevision: revision(), startedAt: new Date().toISOString(),
        processStartupMs: settings.serverStartupMs,
        configuration: {
            deployment: 'single standalone CouchDB node', databasePath: join(cache, 'data'),
            appIdMapping: 'fixture _id is stored as appId because CouchDB reserves _id for the document key; document key equals uuid',
            updateContract: 'GET latest document revision then PUT the modified document; sustained updates likewise include the read',
            indexDefinitions
        }
    }
    const wallStart = performance.now(), clientCpuStart = process.cpuUsage()
    const database = `cdb-bench-${size}-${runIndex}-${Date.now().toString(36)}`
    result.database = database
    result.serverMemory = { idle: processTotals() }
    result.clientMemory = { idle: process.memoryUsage() }
    const indexByName = {}
    try {
        await request(`/${database}`, { method: 'PUT' })
        const indexStart = performance.now()
        for (const definition of indexDefinitions) {
            const index = await createIndex(database, definition)
            indexByName[index.name] = index
            const selector = index.name === 'group_uuid' ? { group: 'group-3' }
                : index.name === 'profile_team_uuid' ? { 'profile.team': 'team-7' }
                    : index.name === 'rank_idx' ? { rank: { $gte: 0 } }
                        : index.name === 'group_active_uuid' ? { group: 'group-4', active: true }
                            : index.name === 'bulk_delete' ? { bulkDelete: true }
                                : { uuid: { $gte: '' } }
            await findDocs(database, index, selector,
                index.name === 'rank_idx' ? [{ rank: 'asc' }] : index.name === 'bulk_delete' ? null : [{ uuid: 'asc' }], 1)
        }
        result.indexSetupMs = performance.now() - indexStart

        const fixtureHash = createHash('sha256')
        fixtureHash.update('[')
        let firstRecord = true, createAndIndexMs = 0
        const seed = {
            uuid: `seed-${runIndex}-${size}`, _id: `seed-${runIndex}-${size}`,
            rank: -1, group: 'seed', active: false, createdAt: '2020-01-01T00:00:00.000Z',
            profile: { team: 'seed', score: 0, location: { region: 'seed', verified: false } },
            tags: [], payload: 'seed', bulkDelete: false, revision: 0
        }
        const firstCreateStart = performance.now()
        await request(dbPath(database, `/${seed.uuid}`), { method: 'PUT', body: databaseDoc(seed) })
        result.firstObjectCreateMs = performance.now() - firstCreateStart

        const reportProgress = createProgressReporter('couchdb', size)
        for (let offset = 0; offset < size; offset += 1000) {
            const records = []
            const end = Math.min(size, offset + 1000)
            for (let rank = offset; rank < end; rank++) {
                const record = createBenchmarkRecord(rank, size, lifecycleRoot(size).organization_id)
                if (!firstRecord) fixtureHash.update(',')
                fixtureHash.update(JSON.stringify(record)); firstRecord = false
                records.push(databaseDoc(record))
            }
            const start = performance.now()
            const inserted = await request(dbPath(database, '/_bulk_docs'), { method: 'POST', body: { docs: records } })
            assert.equal(inserted.json.length, end - offset)
            for (const row of inserted.json) {
                assert.ok(row.ok, `bulk insert ${row.id}: ${row.reason ?? row.error}`)
            }
            createAndIndexMs += performance.now() - start
            reportProgress(end)
        }
        fixtureHash.update(']')
        result.fixtureHash = fixtureHash.digest('hex')
        result.createAndIndexMs = createAndIndexMs
        result.createRecordsPerSecond = size / createAndIndexMs * 1000
        result.indexCreationAndMaintenance = { indexSetupMs: result.indexSetupMs, indexesMaintainedDuringBulkIngest: true, indexes: Object.values(indexByName) }

        const catchupStart = performance.now()
        let visibleCount = 0
        while (performance.now() - catchupStart < 30000) {
            const scan = await findDocs(database, indexByName.group_uuid,
                { group: { $gte: 'group-0' } }, [{ group: 'asc' }, { uuid: 'asc' }], size + 1)
            visibleCount = scan.docs.length
            if (visibleCount === size + 1) break
            await delay(100)
        }
        result.indexCatchupMs = performance.now() - catchupStart
        assert.equal(visibleCount, size + 1, 'CouchDB Mango index catches up with seeded documents')

        const info = (await request(`/${database}`)).json
        result.databaseStats = { docCount: info.doc_count, diskSizeBytes: info.disk_size, dataSizeBytes: info.data_size }
        result.serverMemory.loaded = processTotals()
        result.serverMemory.peakRssBytes = result.serverMemory.loaded.peakRssBytes
        result.clientMemory.loaded = process.memoryUsage()

        const workload = standardWorkloads(size)
        const queries = [
            { key: 'equality', index: indexByName.group_uuid, selector: { group: workload.equality.value }, sort: [{ uuid: 'asc' }], expected: expectedIds(size, workload.equality.matches) },
            { key: 'nestedEquality', index: indexByName.profile_team_uuid, selector: { 'profile.team': workload.nestedEquality.value }, sort: [{ uuid: 'asc' }], expected: expectedIds(size, workload.nestedEquality.matches) },
            { key: 'numericRange', index: indexByName.rank_idx, selector: { rank: { $gte: workload.numericRange.lower, $lt: workload.numericRange.upper } }, sort: [{ rank: 'asc' }], expected: expectedIds(size, workload.numericRange.matches) },
            { key: 'and', index: indexByName.group_active_uuid, selector: { group: workload.and.group, active: workload.and.active }, sort: [{ uuid: 'asc' }], expected: expectedIds(size, workload.and.matches) },
            { key: 'or', index: null, selector: { $or: workload.or.groups.map(group => ({ group })) }, sort: null, expected: expectedIds(size, workload.or.matches) }
        ]
        const query = item => findDocs(database, item.index, item.selector, item.sort, 100)
        const middle = benchmarkUuid(Math.floor(size / 2))
        assert.equal((await request(dbPath(database, `/${middle}`))).json.uuid, middle, 'UUID direct read')
        for (const item of queries) {
            let docs
            try { docs = (await query(item)).docs }
            catch (error) { error.message = `${item.key} query failed: ${error.message}`; throw error }
            verifyIds(item.key === 'or' ? docs.sort((a, b) => a.uuid.localeCompare(b.uuid)) : docs, item.expected, item.key)
        }
        result.queryPlans = {}
        for (const item of queries) {
            const explained = await request(dbPath(database, '/_explain'), {
                method: 'POST', body: queryBody(item.index, item.selector, item.sort, 100)
            })
            result.queryPlans[item.key] = { index: explained.json.index, selector: explained.json.selector, opts: explained.json.opts }
        }

        result.operations = {}
        result.operations.uuidRead = await measure(async () => [await request(dbPath(database, `/${middle}`)).then(response => response.json)], docs => {
            assert.equal(docs[0].uuid, middle)
        }, settings)
        for (const item of queries)
            result.operations[item.key] = await measure(() => query(item).then(response => response.docs), docs => verifyIds(item.key === 'or' ? docs.sort((a, b) => a.uuid.localeCompare(b.uuid)) : docs, item.expected, item.key), settings)

        let createRank = size + 1000 + runIndex * (settings.warmups + settings.samples + 100)
        result.operations.singleCreate = await measure(async () => {
            const record = createBenchmarkRecord(createRank++, size, lifecycleRoot(size).organization_id)
            const response = await request(dbPath(database, `/${record.uuid}`), { method: 'PUT', body: databaseDoc(record) })
            return response.json
        }, response => assert.ok(response.rev), settings)

        const updateDocument = async (uuid, mutator) => {
            const doc = (await request(dbPath(database, `/${uuid}`))).json
            mutator(doc)
            return request(dbPath(database, `/${uuid}`), { method: 'PUT', body: doc }).then(response => response.json)
        }
        let updateRank = 0
        result.operations.singleKeyUpdate = await measure((stage, index) => updateDocument(benchmarkUuid(updateRank++), doc => {
            doc.note = `note-${stage}-${index}`
        }), response => assert.ok(response.rev), settings)
        const indexedStart = Math.floor(size / 3)
        let indexedRank = indexedStart
        result.operations.indexedKeyUpdate = await measure((stage, index) => updateDocument(benchmarkUuid(indexedRank++), doc => {
            doc.group = `updated-group-${stage}-${index}`
        }), response => assert.ok(response.rev), settings)
        const updatedGroup = `updated-group-sample-${settings.samples - 1}`
        const updatedMatch = await findDocs(database, indexByName.group_uuid, { group: updatedGroup }, [{ uuid: 'asc' }], 10)
        assert.equal(updatedMatch.docs.length, 1, 'indexed update is visible through the updated group index')
        assert.equal(updatedMatch.docs[0].uuid, benchmarkUuid(indexedStart + settings.warmups + settings.samples), 'indexed update targets expected UUID')
        result.operations.numericIncrement = await measure((stage, index) => updateDocument(benchmarkUuid(Math.floor(size / 2) + index), doc => {
            doc.revision++
        }), response => assert.ok(response.rev), settings)
        const deleteOffset = size + 5000 + runIndex * (settings.warmups + settings.samples + 100)
        const deleteIds = []
        for (let i = 0; i < settings.warmups + settings.samples + 1; i++) {
            const record = createBenchmarkRecord(deleteOffset + i, size, lifecycleRoot(size).organization_id)
            deleteIds.push(record.uuid)
            await request(dbPath(database, `/${record.uuid}`), { method: 'PUT', body: databaseDoc(record) })
        }
        let deleteIndex = 0
        result.operations.singleDelete = await measure(async () => {
            const uuid = deleteIds[deleteIndex++]
            const latest = (await request(dbPath(database, `/${uuid}`))).json
            return request(dbPath(database, `/${uuid}?rev=${encodeURIComponent(latest._rev)}`), { method: 'DELETE' }).then(response => response.json)
        }, response => assert.equal(response.ok, true), settings)
        const filteredDeleteStart = performance.now()
        const bulkMatches = await findDocs(database, indexByName.bulk_delete, { bulkDelete: true }, null, size + 1, ['_id', '_rev'])
        const expectedBulkDelete = Math.min(size, 25)
        assert.equal(bulkMatches.docs.length, expectedBulkDelete)
        const bulkDelete = await request(dbPath(database, '/_bulk_docs'), {
            method: 'POST', body: { docs: bulkMatches.docs.map(doc => ({ _id: doc._id, _rev: doc._rev, _deleted: true })) }
        })
        assert.equal(bulkDelete.json.length, expectedBulkDelete)
        assert.ok(bulkDelete.json.every(row => row.ok))
        result.operations.filteredBulkDelete = { deleted: expectedBulkDelete, elapsedMs: performance.now() - filteredDeleteStart }
        assert.equal((await findDocs(database, indexByName.bulk_delete, { bulkDelete: true }, null, 1)).docs.length, 0)

        const sustainedIds = Array.from({ length: Math.min(size - expectedBulkDelete, 10000) }, (_, rank) => benchmarkUuid(rank))
        result.sustained = []
        for (const concurrency of settings.concurrency) for (const mode of ['read', 'write', 'mixed']) {
            const start = processTotals()
            result.sustained.push(await sustained(database, sustainedIds, settings, mode, concurrency, start))
        }
        const finalInfo = (await request(`/${database}`)).json
        result.databaseStatsFinal = { docCount: finalInfo.doc_count, diskSizeBytes: finalInfo.disk_size, dataSizeBytes: finalInfo.data_size }
        result.clientCpuUsageUs = process.cpuUsage(clientCpuStart)
        result.totalElapsedMs = performance.now() - wallStart
        result.clientMemory.final = process.memoryUsage()
        result.clientMemory.peakRssBytes = process.resourceUsage().maxRSS * 1024
        result.serverResourceUsage = { start: result.serverMemory.idle, final: processTotals() }
        result.completedAt = new Date().toISOString()
        result.status = 'passed'
    } catch (error) {
        result.status = 'failed'
        result.failure = { name: error.name, message: error.message, context: error.context?.toJSON?.() ?? error.context, stack: error.stack }
        result.completedAt = new Date().toISOString()
        result.totalElapsedMs = performance.now() - wallStart
    } finally {
        await request(`/${database}`, { method: 'DELETE', allow: [404] }).catch(error => { result.cleanupError = error.message })
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
        suite: 'CouchDB comparison benchmark v1', provider: 'CouchDB', serverVersion: couchdbVersion,
        runId, startedAt: started.toISOString(), sizes, independentRunsRequested: runs,
        sampleCount: samples, warmupCount: warmups, sustainedDurationMs: sustainMs, concurrencyLevels: concurrency,
        resourcePolicy: 'one isolated CouchDB server process; fresh database per independent run; CouchDB stops after suite', results: []
    }
    try {
        const startup = await startServer()
        manifest.serverStartupMs = startup.elapsedMs
        manifest.serverVersionReported = startup.version
        manifest.serverConfiguration = await initializeServer()
        console.log(`couchdb=${startup.version} startup=${startup.elapsedMs.toFixed(0)}ms`)
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
                    JSON.stringify({ samples, warmups, sustainMs, concurrency, serverStartupMs: startup.elapsedMs })])
                let raw
                try { raw = JSON.parse(await readFile(path, 'utf8')) } catch {}
                const status = child.code === 0 && raw?.status === 'passed' ? 'passed' : 'failed'
                if (!raw) raw = { status, datasetSize: size, runIndex, failure: { message: 'CouchDB benchmark child exited before writing a result', exitCode: child.code, signal: child.signal, stderr: child.stderr } }
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

async function exists(path) {
    try { await import('node:fs/promises').then(fs => fs.access(path)); return true } catch { return false }
}
