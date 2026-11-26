import test from 'node:test'
import assert from 'node:assert/strict'
import { waitForIndex, waitForCondition } from './benchmarks/shared/wait-for-index.mjs'
import DB from '../test-support/database.mjs'

test('organization data uses separate trees and disk directories', async () => {
    const db = await DB()
    const platform = { organization_id: 'platform', storage: 'main', database: 'app', array: 'organizations' }
    const id = '507f1f77bcf86cd799439011'
    const record = await db.send({ ...platform, method: 'object.create', object: { uuid: id, name: 'Acme' } })
    assert.equal(record.success, true)
    const context = { organization_id: id, storage: 'main', database: 'app', array: 'products' }
    const result = await db.send({ ...context, method: 'object.create', object: { uuid: 'product' } })
    assert.equal(result.success, true, result.error?.join('; '))
    await waitForIndex(db)
    const config = JSON.parse(JSON.stringify(db.config))
    assert.equal(Object.hasOwn(config.roots, '$organization_id'), false)
    assert.deepEqual(Object.keys(config.leaves), [])
    assert.equal((await db.send({ ...platform, method: 'object.read', object: { uuid: id } })).object[0].name, 'Acme')
    assert.equal((await db.send({ ...context, method: 'object.read', object: { uuid: id } })).object.length, 0)
    const platformTree = await db.organizations.get('platform')
    const organizationTree = await db.organizations.get(id)
    assert.notEqual(platformTree, organizationTree)
    assert.equal(platformTree.config.leaves[result.object[0].uuid], undefined)
    assert.equal(Object.hasOwn(result.object[0], 'organization_id'), false)
    assert.ok(Object.hasOwn(organizationTree.config.roots, 'storage'))
    await waitForIndex(db)
    const directories = await db.disk.execute({ operation: 'list', kind: 'directory' })
    assert.ok(directories.includes('platform'))
    assert.ok(directories.includes(id))
    const reopened = await DB({}, { disk: db.disk, config })
    const restored = await reopened.send({ ...context, method: 'object.read', object: { uuid: 'product' } })
    assert.equal(restored.success, true, restored.error?.join('; '))
    assert.equal(restored.object[0].uuid, 'product')
    assert.equal((await reopened.send({ ...platform, method: 'object.read', object: { uuid: 'product' } })).object.length, 0)
    await db.close()
    await reopened.close()
})

test('arbitrary dynamic root names resolve generically at multiple depths', async () => {
    const db = await DB({}, { roots: { $tenant_id: { $project_id: { object: {} } } } })
    const context = { organization_id: 'organization', tenant_id: 'tenant', project_id: 'project' }
    const creation = await db.send({ ...context, method: 'object.create', object: { uuid: 'item' } })
    assert.equal(creation.success, true, creation.error?.join('; '))
    await waitForIndex(db)
    const config = (await db.organizations.get('organization')).config.leaves
    const project = config[creation.object[0].parent]
    assert.equal(project.root, '$project_id')
    assert.equal(project.name, 'project')
    assert.equal(config[project.parent].root, '$tenant_id')
    assert.equal(config[project.parent].name, 'tenant')
    assert.equal((await db.send({ ...context, method: 'object.read', object: { uuid: 'item' } })).object.length, 1)
    assert.equal((await db.send({ ...context, tenant_id: 'other', method: 'object.read', object: { uuid: 'item' } })).object.length, 0)
    assert.equal((await db.send({ ...context, project_id: 'other', method: 'object.read', object: { uuid: 'item' } })).object.length, 0)
    assert.equal((await db.send({ ...context, method: 'object.read', filter: { query: {} } })).object.length, 1)
    await db.close()
})
