import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { initializeServerDB } from '../src/server.js'
import { registerPersistenceDriver, persistenceDrivers } from '../src/persistence/driver.js'
import { removeMemoryPath } from '../src/memory.js'

test('configured MongoDB and workflows are bypassed while local documents and bytes persist', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'coc-local-only-'))
    let providerCalls = 0, workflowCalls = 0
    const previous = persistenceDrivers.get('mongodb')
    registerPersistenceDriver('mongodb', { send() { providerCalls++; throw Error('External provider must not run') } })
    const server = Object.assign(new EventEmitter(), { id: 'local-test', isPrimary: true,
        send: async payload => payload,
        cluster: Object.assign(new EventEmitter(), { send() {} }),
        workflow: { run() { workflowCalls++; throw Error('External workflow must not run') } } })
    const db = initializeServerDB(server, { directory, memoryOnly: false,
        bootstrapPersistence: { name: 'mongodb', provider: 'mongodb' },
        persistence: { workflow: 'must-not-run' } })
    t.after(async () => {
        await db.close()
        if (previous) persistenceDrivers.set('mongodb', previous)
        else persistenceDrivers.delete('mongodb')
        removeMemoryPath(directory)
        await rm(directory, { recursive: true, force: true })
    })
    const scope = { organization_id: '000000000000000000000001', storage: 'dev', database: 'app', array: 'servers', persistence: 'mongodb' }
    const created = await db.send({ ...scope, method: 'object.create', object: { workers: 1 } })
    assert.equal(created.success, true, created.error)
    const id = created.object[0]._id
    const updated = await db.send({ ...scope, method: 'object.update', object: { _id: id, $set: { workers: 2 } } })
    assert.equal(updated.success, true, updated.error)
    await db.flush()
    const missing = await db.send({ ...scope, method: 'object.read', object: { _id: '000000000000000000000099' } })
    assert.equal(missing.success, true, missing.error)
    assert.deepEqual(missing.object, [])
    const paths = await readdir(directory, { recursive: true })
    const path = join(directory, paths.find(path => path.endsWith(`objects/${id}.json`)))
    assert.equal(JSON.parse(await readFile(path, 'utf8')).workers, 2)
    const bytes = JSON.parse(await readFile(join(dirname(path), '.bytes'), 'utf8'))
    assert.equal(bytes[`${id}.json`], (await stat(path)).size)
    assert.throws(() => db.persistence.send({ ...scope, method: 'object.read' }), /temporarily disabled/)
    assert.throws(() => db.persistence.getDriver('mongodb'), /temporarily disabled/)
    assert.equal(providerCalls, 0)
    assert.equal(workflowCalls, 0)
})
