import test from 'node:test'
import assert from 'node:assert/strict'
import DB from '../src/index.js'

test('organization record and named organization scope have independent identities', async () => {
    const db = DB()
    const platform = { organization_id: 'platform', storage: 'main', database: 'app', array: 'organizations' }
    const id = '507f1f77bcf86cd799439011'
    const record = await db.send({ ...platform, method: 'object.create', object: { uuid: id, name: 'Acme' } })
    assert.equal(record.success, true)
    const context = { organization_id: id, storage: 'main', database: 'app', array: 'products' }
    const result = await db.send({ ...context, method: 'object.create', object: { uuid: 'product' } })
    assert.equal(result.success, true, result.error?.join('; '))
    const config = JSON.parse(JSON.stringify(db.config))
    const [rootId, root] = Object.entries(config.artifacts).find(([, v]) => v.scope === '$organization_id' && v.name === id)
    assert.match(rootId, /^[a-f0-9]{32}$/)
    assert.notEqual(rootId, id)
    assert.equal(config.artifacts[id], undefined)
    assert.equal(root.parent, undefined)
    assert.equal((await db.send({ ...platform, method: 'object.read', object: { uuid: id } })).object[0].name, 'Acme')
    assert.equal((await db.send({ ...context, method: 'object.read', object: { uuid: id } })).object.length, 0)
    const copy = DB({}, { config })
    const created = await copy.send({ ...context, method: 'object.create', object: { uuid: 'another' } })
    assert.equal(created.success, true)
    assert.equal(created.object[0].parent, result.object[0].parent)
    assert.deepEqual(JSON.parse(JSON.stringify(copy.config)), config)
})

test('arbitrary dynamic scope names resolve generically at multiple depths', async () => {
    const db = DB({}, { scopes: { $tenant_id: { $project_id: { object: {} } } } })
    const context = { tenant_id: 'tenant', project_id: 'project' }
    const creation = await db.send({ ...context, method: 'object.create', object: { uuid: 'item' } })
    assert.equal(creation.success, true, creation.error?.join('; '))
    const config = db.config.artifacts
    const project = config[creation.object[0].parent]
    assert.equal(project.scope, '$project_id')
    assert.equal(project.name, 'project')
    assert.equal(config[project.parent].scope, '$tenant_id')
    assert.equal(config[project.parent].name, 'tenant')
    assert.equal((await db.send({ ...context, method: 'object.read', object: { uuid: 'item' } })).object.length, 1)
    assert.equal((await db.send({ ...context, tenant_id: 'other', method: 'object.read', object: { uuid: 'item' } })).object.length, 0)
    assert.equal((await db.send({ ...context, project_id: 'other', method: 'object.read', object: { uuid: 'item' } })).object.length, 0)
    assert.equal((await db.send({ ...context, method: 'object.read', filter: { query: {} } })).object.length, 1)
})
