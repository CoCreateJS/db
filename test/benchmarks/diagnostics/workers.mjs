import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const execute = promisify(execFile)
const root = fileURLToPath(new URL('../../../', import.meta.url))
const records = Number(process.argv[2] ?? 10000)
const output = resolve(process.env.BENCH_OUTPUT_DIR ?? `${root}/test/benchmarks/providers/cocreatedb/results/worker-trees-${records}-${new Date().toISOString().replaceAll(':', '-')}`)
await mkdir(output, { recursive: true })
const results = []
for (const workers of [1, 2]) {
    const file = `${output}/${workers}-workers.json`
    const { stdout } = await execute(process.execPath, ['test-support/worker-db.mjs'], { cwd: root,
        env: { ...process.env, DB_RECORDS: String(records), DB_WORKERS: String(workers), DB_RESULT: file },
        timeout: 180000, maxBuffer: 4 * 1024 * 1024 })
    const result = JSON.parse(stdout.trim().split('\n').at(-1))
    assert.equal(result.status, 'passed')
    results.push(result)
    console.log(JSON.stringify({ workers, records, acknowledgementMs: result.acknowledgementMs, createAndIndexMs: result.createAndIndexMs, file }))
}
assert.equal(results[0].fixtureHash, results[1].fixtureHash)
await writeFile(`${output}/comparison.json`, JSON.stringify({ scope: 'one organization, four primary tables, same fixture, separate sequential runs',
    sampleCount: 1, results }, null, 2) + '\n')
console.log(`results=${output}`)
