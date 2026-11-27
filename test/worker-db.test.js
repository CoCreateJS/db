import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)
test('primary orchestrates independent Trees in real workers through CoCreate IPC', { timeout: 45000 }, async () => {
    const { stdout } = await execute(process.execPath, ['test-support/worker-db.mjs'], {
        cwd: new URL('../', import.meta.url), timeout: 40000,
        env: { ...process.env, DB_RECORDS: '80', DB_WORKERS: '2' }, maxBuffer: 1024 * 1024
    })
    const result = JSON.parse(stdout.trim().split('\n').at(-1))
    assert.equal(result.status, 'passed')
    assert.equal(result.primaryTreeCount, 0)
    assert.equal(result.pendingIndexCount, 0)
    assert.equal(result.workers, 2)
    assert.equal(new Set(result.dataOwners.map(tree => tree.workerId)).size, 2)
})

test('an orchestrating primary without workers never falls back to a local Tree', async () => {
    const { EventEmitter } = await import('node:events')
    const { createRuntime } = await import('../src/runtime.js')
    const server = new EventEmitter()
    Object.assign(server, { isPrimary: true, isWorker: false, id: 'orchestrator', workers: new Map() })
    const db = await createRuntime(server)
    try {
        const response = await db.send({ organization_id: 'org', storage: 'main', database: 'app', array: 'items',
            method: 'object.create', object: { value: 1 } })
        assert.equal(response.success, false)
        assert.match(response.error.join('; '), /No DB workers/)
        assert.equal(db.trees.organizations.size, 0)
    } finally { await db.close() }
})
