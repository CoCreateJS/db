import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)
test('three worker processes own complete DB instances without DB IPC', { timeout: 15000 }, async () => {
    const results = await Promise.all(['first', 'second', 'third'].map(async value => {
        const { stdout } = await execute(process.execPath, ['test-support/local-db-fork.mjs', value], {
            cwd: new URL('../', import.meta.url), timeout: 10000
        })
        return JSON.parse(stdout.trim())
    }))
    assert.equal(new Set(results.map(result => result.pid)).size, 3)
    assert.deepEqual(results.map(result => result.value), ['first', 'second', 'third'])
    assert.ok(results.every(result => result.status === 'passed'))
})
