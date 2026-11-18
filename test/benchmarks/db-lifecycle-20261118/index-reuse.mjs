import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { availableParallelism, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createDB } from '../../../src/index.js'
import { flattenIndexValues } from '../../../src/storage.js'
import { removeMemoryPath } from '../../../src/memory.js'

const size = Number(process.argv[2] ?? 1000)
const startedAt = new Date()
const directory = await mkdtemp(join(tmpdir(), 'coc-db-index-reuse-'))
const organization_id = randomBytes(12).toString('hex')
const scope = { organization_id, storage: 'bench', database: 'app', array: 'records' }
const db = createDB({ directory, memoryOnly: true })
const result = { benchmark: 'cocreatedb-same-index-fields-reuse', startedAt: startedAt.toISOString(), node: process.version,
    platform: `${process.platform}-${process.arch}`, cpuCount: availableParallelism(), mode: 'memoryOnly: true', sizePerBatch: size, rounds: [] }
const send = (method, extra = {}) => db.send({ ...scope, method: `object.${method}`, ...extra })
const assertSuccess = (response, method) => {
    if (!response || response.success === false) throw Error(`${method} failed: ${response?.error?.join('; ') ?? 'no response'}`)
}

try {
    for (const request of [
        { method: 'storage.create', storage: { name: scope.storage } },
        { method: 'database.create', database: { name: scope.database } },
        { method: 'array.create', array: { name: scope.array } }
    ]) assertSuccess(await db.send({ ...scope, ...request }), request.method)

    for (let round = 0; round < 2; round++) {
        const offset = round * size
        const objects = Array.from({ length: size }, (_, index) => {
            const rank = offset + index
            return { rank, group: `group-${rank % 10}`, revision: 0 }
        })
        const started = performance.now()
        assertSuccess(await send('create', { object: objects }), 'object.create')
        const acknowledgedMs = performance.now() - started
        const indexed = performance.now()
        await db.flush()
        result.rounds.push({ round: round + 1, documents: size, indexEntriesPerDocument: flattenIndexValues(objects[0]).length,
            acknowledgedMs, indexFlushMs: performance.now() - indexed })
    }
} finally {
    await db.close()
    removeMemoryPath(directory)
    await rm(directory, { recursive: true, force: true })
}

result.completedAt = new Date().toISOString()
const outputDirectory = resolve('test/benchmarks/db-lifecycle-20261118/results')
await mkdir(outputDirectory, { recursive: true })
const output = join(outputDirectory, `reuse-${startedAt.toISOString().replaceAll(':', '-')}.json`)
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify(result, null, 2))
console.log(`results=${output}`)
