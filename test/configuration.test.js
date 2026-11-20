import test from 'node:test'
import assert from 'node:assert/strict'
import createDB from '../src/index.js'
const path = { organization_id: 'org', storage: 'production', database: 'app', array: 'products' }
const create = (db, path, uuid) => db.send({ ...path, method: 'object.create', object: { uuid, price: 1 } })

test('transfer configuration, reuse scope identities, keep ordinary objects local', async () => {
    const a = createDB()
    assert.deepEqual(Object.keys(a).sort(), ['config','send'])
    const first = await create(a, path, 'a')
    assert.equal(first.success, true, first.error?.join('; '))
    const second = await create(a, { ...path, array:'users' }, 'b')
    assert.equal(second.success, true)
    const config = JSON.parse(JSON.stringify(a.config))
    assert.equal(Object.keys(config.artifacts).length, 5)
    const [rootId, root] = Object.entries(config.artifacts).find(([, value]) => value.scope === '$organization_id')
    assert.notEqual(rootId, path.organization_id)
    assert.equal(root.name, path.organization_id)
    assert.equal(config.artifacts[first.object[0].parent].name, 'products')
    assert.equal(config.artifacts.a, undefined)
    const b = createDB(undefined, { config })
    assert.deepEqual(JSON.parse(JSON.stringify(b.config)), config)
    assert.equal((await b.send({method:'object.read', object:{uuid:'a'}})).object.length,0)
    const result = await create(b, path, 'c')
    assert.equal(result.success, true, result.error?.join('; '))
    assert.equal(result.object[0].parent, first.object[0].parent)
    assert.deepEqual(JSON.parse(JSON.stringify(b.config)), config)
    const sibling = await create(b, {...path,array:'users'},'d')
    assert.equal(sibling.object[0].parent,second.object[0].parent)
    assert.equal((await b.send({...path, method:'object.read', object:{uuid:'d'}})).object.length,0)
})

test('managed dot paths, defensive snapshots and invalid mutations', async () => {
    const db = createDB()
    const config = db.config
    config.scopes.fake = {}
    assert.equal(db.config.scopes.fake, undefined)
    config.setValue('scopes.status', {})
    assert.deepEqual(config.getValue('scopes.status'), {})
    assert.equal((await db.send({method:'status.create',status:{name:'ok'}})).success,true)
    assert.throws(() => config.setValue('scopes.status', undefined), /occupied/)
    assert.throws(() => config.setValue('scopes.__proto__.polluted', {}))
    assert.throws(() => config.setValue('artifacts.fake', {}))
    assert.equal({}.polluted,undefined)
    const result = await create(db,path,'x')
    const parent = (await db.send({method:'array.read',array:{uuid:result.object[0].parent}})).array[0]
    assert.throws(() => parent.setValue('name','changed'))
    assert.equal((await db.send({method:'array.update',array:{uuid:parent.uuid,name:'changed'}})).success,false)
    assert.equal(db.config.artifacts[parent.uuid].name,'products')
})

test('reject orphaned and duplicate scope identities at initialization', () => {
    const config = JSON.parse(JSON.stringify(createDB().config))
    config.artifacts.x = {scope:'array',parent:'missing',name:'items'}
    assert.throws(() => createDB(undefined,{config}), /Missing or cyclic/)
    config.artifacts = {org:{scope:'$organization_id',name:'org'},a:{scope:'storage',parent:'org',name:'main'},b:{scope:'storage',parent:'org',name:'main'}}
    assert.throws(() => createDB(undefined,{config}), /duplicate/)
})

test('worker does not independently mutate configuration', () => {
    const worker = createDB({isPrimary:false})
    assert.throws(() => worker.config.setValue('scopes.status', {}), /primary/)
})
