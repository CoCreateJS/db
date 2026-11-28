import assert from 'node:assert/strict'
import DB from '../src/index.js'
import { databaseRuntimes } from '../src/runtime.js'
import { waitForIdle } from '../test/benchmarks/shared/wait-for-index.mjs'
import { MemoryDisk } from './memory-disk.mjs'

const value = process.argv[2]
const scope = { organization_id: 'shared-org', storage: 'main', database: 'app', array: 'items' }
const db = await DB.init({ isPrimary: false, isWorker: true,
    send() { throw Error('DB must execute without transport') }
}, { prompt: false, disk: new MemoryDisk() })
const runtime = databaseRuntimes.get(db)
try {
    const created = await db.send({ ...scope, method: 'object.create', object: { uuid: 'same-id', value } })
    assert.equal(created.success, true)
    await waitForIdle(runtime)
    const read = await db.send({ ...scope, method: 'object.read', filter: { query: { value }, limit: 1 } })
    assert.equal(read.object[0].value, value)
    const updated = await db.send({ ...scope, method: 'object.update', object: { uuid: 'same-id', value: `${value}-updated` } })
    assert.equal(updated.success, true)
    await waitForIdle(runtime)
    const found = await db.send({ ...scope, method: 'object.read', filter: { query: { value: `${value}-updated` }, limit: 1 } })
    assert.equal(found.object[0].uuid, 'same-id')
    const deleted = await db.send({ ...scope, method: 'object.delete', object: { uuid: 'same-id' } })
    assert.equal(deleted.success, true)
    await waitForIdle(runtime)
    const missing = await db.send({ ...scope, method: 'object.read', object: { uuid: 'same-id' } })
    assert.equal(missing.object.length, 0)
    assert.equal(runtime.pendingIndexCount, 0)
    assert.equal(runtime.pendingDiskCount, 0)
    console.log(JSON.stringify({ pid: process.pid, value, status: 'passed' }))
} finally { await runtime.close() }
