import test from 'node:test'
import assert from 'node:assert/strict'
import Config from '@cocreate/config'
import DB from '../src/index.js'

test('init resolves configuration without owning the server', async () => {
    const original = Config.prompt
    const server = {}
    try {
        Config.prompt = async () => ({ db: { version: '2.0.0', scopes: { status: {} }, artifacts: {} } })
        const db = await DB.init(server)
        assert.deepEqual(server, {})
        assert.equal(db.config.getValue('version'), '2.0.0')
        assert.equal((await db.send({ method: 'status.create', status: { name: 'ready' } })).success, true)
        db.config.setValue('scopes.other', {})
        const copy = await DB.init({}, { prompt: false, config: JSON.parse(JSON.stringify(db.config)) })
        assert.deepEqual(JSON.parse(JSON.stringify(copy.config)), JSON.parse(JSON.stringify(db.config)))
        const explicit = await DB.init({}, { config: { version: '3.0.0' } })
        assert.equal(explicit.config.version, '3.0.0')
        assert.deepEqual(explicit.config.scopes, { status: {} })
        Config.prompt = async () => { throw Error('unexpected prompt') }
        const worker = await DB.init({ isWorker: true }, { forward: request => db.send(request) })
        assert.equal((await worker.send({ method: 'status.read', status: { name: 'ready' } })).success, true)
        assert.ok(await DB.init({}, { prompt: false }))
    } finally { Config.prompt = original }
})

test('empty config utility result supports standalone default initialization', async () => {
    const db = await DB.init({})
    assert.ok(db.config.scopes.$organization_id)
    assert.equal(typeof db.send, 'function')
})
