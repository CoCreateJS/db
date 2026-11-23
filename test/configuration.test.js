import test from 'node:test'
import assert from 'node:assert/strict'
import createDB from '../test-support/database.mjs'
const path = { organization_id: 'org', storage: 'production', database: 'app', array: 'products' }
const create = (db, path, uuid) => db.send({ ...path, method: 'object.create', object: { uuid, price: 1 } })

test('transfer configuration, reuse root identities, keep ordinary objects local', async () => {
    const a = await createDB()
    assert.deepEqual(Object.keys(a).sort(), ['baseDirectory','config','leafTier','local','persist','persistence','send'])
    const first = await create(a, path, 'a')
    assert.equal(first.success, true, first.error?.join('; '))
    const second = await create(a, { ...path, array:'users' }, 'b')
    assert.equal(second.success, true)
    await a.flushDisk()
    const config = JSON.parse(JSON.stringify(a.config))
    assert.equal(Object.keys(config.leaves).length, 5)
    const [rootId, root] = Object.entries(config.leaves).find(([, value]) => value.root === '$organization_id')
    assert.notEqual(rootId, path.organization_id)
    assert.equal(root.name, path.organization_id)
    assert.equal(config.leaves[first.object[0].parent].name, 'products')
    assert.equal(config.leaves.a, undefined)
    const b = await createDB(undefined, { config })
    assert.deepEqual(JSON.parse(JSON.stringify(b.config)), config)
    assert.equal((await b.send({method:'object.read', object:{uuid:'a'}})).object.length,0)
    const result = await create(b, path, 'c')
    assert.equal(result.success, true, result.error?.join('; '))
    await b.flushIndex()
    assert.equal(result.object[0].parent, first.object[0].parent)
    assert.deepEqual(JSON.parse(JSON.stringify(b.config)), config)
    const sibling = await create(b, {...path,array:'users'},'d')
    await b.flushDisk()
    assert.equal(sibling.object[0].parent,second.object[0].parent)
    assert.equal((await b.send({...path, method:'object.read', object:{uuid:'d'}})).object.length,0)
})

test('managed dot paths, defensive snapshots and invalid mutations', async () => {
    const db = await createDB()
    const config = db.config
    config.roots.fake = {}
    assert.equal(db.config.roots.fake, undefined)
    await config.setValue('roots.status', {})
    assert.deepEqual(config.getValue('roots.status'), {})
    assert.equal((await db.send({method:'status.create',status:{name:'ok'}})).success,true)
    await assert.rejects(config.setValue('roots.status', undefined), /occupied/)
    await assert.rejects(config.setValue('roots.__proto__.polluted', {}))
    await assert.rejects(config.setValue('leaves.fake', {}))
    assert.equal({}.polluted,undefined)
    const result = await create(db,path,'x')
    await db.flushIndex()
    const parent = (await db.send({method:'array.read',array:{uuid:result.object[0].parent}})).array[0]
    await assert.rejects(parent.setValue('name','changed'))
    assert.equal((await db.send({method:'array.update',array:{uuid:parent.uuid,name:'changed'}})).success,false)
    assert.equal(db.config.leaves[parent.uuid].name,'products')
})

test('reject orphaned and duplicate root identities at initialization', async () => {
    const config = JSON.parse(JSON.stringify((await createDB()).config))
    config.leaves.x = {root:'array',parent:'missing',name:'items'}
    await assert.rejects(createDB(undefined,{config}), /Missing or cyclic/)
    config.leaves = {org:{root:'$organization_id',name:'org'},a:{root:'storage',parent:'org',name:'main'},b:{root:'storage',parent:'org',name:'main'}}
    await assert.rejects(createDB(undefined,{config}), /duplicate/)
})

test('worker does not independently mutate configuration', async () => {
    const worker = await createDB({isPrimary:false})
    await assert.rejects(worker.config.setValue('roots.status', {}), /primary/)
})
