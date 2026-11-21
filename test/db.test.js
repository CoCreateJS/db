import { internal } from './internal.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import createDB from '../src/index.js'
import {createLeaf} from '../src/leaf.js'
import { createLifecycleFixture, lifecycleFixtureHash, lifecycleQueries, lifecycleRoot } from './fixtures/lifecycle.mjs'
test('leaf identity and hidden API',()=>{const data={uuid:'x',price:2,nested:{a:3}},a=createLeaf(data);assert.equal(a,data);assert.equal(a.getIndex('nested.a').object,a);assert.deepEqual(JSON.parse(JSON.stringify(a)),{uuid:'x',price:2,nested:{a:3}});a.setValue('nested.a',4);assert.equal(a.nested.a,4)})
test('grouped trees, random updates and queries',async()=>{const db=internal({size:5}),root={organization_id:'org',storage:'store',database:'db',array:'items'};for(let i=0;i<100;i++)await db.send({...root,method:'object.create',object:{uuid:String(i).padStart(3,'0'),price:i%10}});let seed=123;const rand=n=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)%n);function validate(p){if(p.branches){for(const c of p.branches){assert.equal(c.parent,p);validate(c)}assert.equal(p.length,p.branches.reduce((n,c)=>n+c.length,0))}else {assert.equal(p.length,p.entries.reduce((n,g)=>n+g[1].length,0));for(const [v,es] of p.entries)for(const e of es){assert.equal(e.index,p);assert.equal(e.value,v)}}}for(let i=0;i<2000;i++){const a=db.leaves.get(String(rand(100)).padStart(3,'0')),e=a.getIndex('price');a.setValue('price',rand(40));assert.equal(a.getIndex('price'),e);const t=db.tree.get('price').get('number');validate(t.root);const expected=[...db.leaves.values()].filter(a=>a.root==='object').sort((a,b)=>a.price-b.price||a.uuid.localeCompare(b.uuid));assert.deepEqual([...t.scan()].filter(e=>e.object.root==='object').map(e=>e.uuid),expected.map(a=>a.uuid));assert.deepEqual((await db.send({...root,method:'object.read',filter:{query:{price:{$gte:12,$lt:20}},limit:100}})).object.map(a=>a.uuid),expected.filter(a=>a.price>=12&&a.price<20).map(a=>a.uuid))}})
test('native CRUD and root isolation',async()=>{const p=createDB({isPrimary:true},{size:3}),w=createDB({isPrimary:false},{forward:r=>p.send(r)}),root={organization_id:'org',storage:'store',database:'db',array:'items'};const a=(await w.send({...root,method:'object.create',object:{uuid:'x',price:1}})).object[0];assert.equal((await w.send({...root,method:'object.update',object:{uuid:'x',price:'a',name:'hi'}})).success,true);assert.equal((await w.send({...root,method:'object.read',filter:{query:{price:'a'}}})).object[0],a);assert.equal((await w.send({...root,array:'other',method:'object.read',object:{uuid:'x'}})).object.length,0);await w.send({...root,method:'object.update',object:{uuid:'x',name:undefined}});assert.equal(a.name,undefined);await w.send({...root,method:'object.delete',object:{uuid:'x'}});assert.equal((await p.send({method:'object.read',object:{uuid:'x'}})).object.length,0);assert.equal((await w.send({...root,method:'object.read',filter:{query:{price:'a'}}})).object.length,0)})
test('shared update operators and query predicates',async()=>{const db=createDB({isPrimary:true},{size:3}),root={organization_id:'org',storage:'store',database:'db',array:'items'},send=(method,extra)=>db.send({...root,method:`object.${method}`,...extra});const a=(await send('create',{object:{revision:0,profile:{team:'a'},tags:['x','y']}})).object[0];const entry=a.getIndex('revision');assert.equal((await send('update',{object:{uuid:a.uuid,$update:{$inc:{revision:2},$push:{tags:'z'},$set:{'profile.team':'b'}}}})).success,true);assert.equal(a.revision,2);assert.equal(a.getIndex('revision'),entry);assert.deepEqual(a.tags,['x','y','z']);assert.equal((await send('read',{filter:{query:{$and:[{revision:{$gte:2}},{'profile.team':'b'},{tags:{$includes:'z'}}]},limit:0}})).object[0],a);assert.equal((await send('update',{object:{uuid:a.uuid,$update:{$inc:{revision:'bad'}}}})).success,false);assert.equal(a.revision,2);assert.equal((await send('read',{filter:{query:{revision:0}}})).object.length,0);})

test('shared lifecycle fixture supports direct old/new workload comparison', async () => {
    const size = 100
    const objects = createLifecycleFixture(size)
    const fixtureHash = lifecycleFixtureHash(objects)
    const queries = lifecycleQueries(size)
    const db = createDB({ isPrimary: true })
    const send = (method, extra = {}) => db.send({
        ...lifecycleRoot(size),
        method: `object.${method}`,
        ...extra
    })

    try {
        const created = await send('create', { object: objects })
        assert.equal(created.success, true, created.error?.join('; '))
        assert.equal(created.object.length, size)
        assert.equal(lifecycleFixtureHash(createLifecycleFixture(size)), fixtureHash)

        const selected = objects[queries.selectedRank]
        assert.equal((await send('read', { object: { uuid: selected.uuid } })).object[0], selected)
        assert.equal((await send('read', { filter: { query: queries.equality.query, limit: 0 } })).object.length,
            queries.equality.count)
        assert.equal((await send('read', { filter: { query: queries.nested.query, limit: 0 } })).object.length,
            queries.nested.count)
        assert.equal((await send('read', { filter: { query: queries.range.query, limit: 0 } })).object.length,
            queries.range.count)

        const updated = await send('update', {
            object: { uuid: selected.uuid, $update: { $inc: { revision: 1 } } }
        })
        assert.equal(updated.success, true, updated.error?.join('; '))
        assert.equal(selected.revision, 1)

        const batch = objects.slice(0, 25)
        const deleted = await send('delete', { object: batch.map(({ uuid }) => ({ uuid })) })
        assert.equal(deleted.success, true, deleted.error?.join('; '))
        assert.equal(deleted.object.length, 25)
        for (const { uuid } of batch)
            assert.equal((await send('read', { object: { uuid } })).object.length, 0)
    } finally {
        await db.close?.()
    }
})

test('configurable roots share leaves and tree indexes', async () => {
    const customRoots = {
        $organization_id: {
            storage: { database: { array: { object: {}, index: {} } }, archive: {} }
        }
    }
    const db = internal({ roots: customRoots, size: 3 })
    assert.deepEqual(db.config.roots, customRoots)
    assert.equal(db.config.version, '1.0.0')
    const request = {
        organization_id: 'org-a', storage: 'main', database: 'app', array: 'users',
        method: 'object.create', object: { uuid: 'user-a', name: 'Ada' }
    }
    const created = await db.send(request)
    assert.equal(created.success, true, created.error?.join('; '))
    const user = created.object[0]
    assert.equal(db.leaves.get(user.uuid), user)
    const array = [...db.leaves.values()].find(a => a.name === request.array)
    const database = [...db.leaves.values()].find(a => a.name === request.database)
    const storage = [...db.leaves.values()].find(a => a.name === request.storage)
    assert.equal(user.parent, array.uuid)
    assert.equal(array.parent, database.uuid)
    assert.equal(database.parent, storage.uuid)
    assert.equal(storage.parent, [...db.leaves.values()].find(a => a.name === 'org-a').uuid)
    assert.equal([...db.tree.get('root').get('string').scan()].length > 0, true)
    const index = await db.send({ ...request, method: 'index.create', index: { name: 'byName' } })
    assert.equal(index.success, true, index.error?.join('; '))
    assert.equal(index.index[0].parent, array.uuid)
    assert.equal(index.index[0].root, 'index')

    const isolated = await db.send({ ...request, organization_id: 'org-b', object: { uuid: 'user-b', name: 'Grace' } })
    assert.equal(isolated.success, true)
    assert.deepEqual((await db.send({ ...request, organization_id: 'org-b', method: 'object.read', object: { uuid: 'user-a' } })).object, [])
    assert.equal((await db.send({ ...request, method: 'object.read', object: { uuid: 'user-a' } })).object[0], user)

    const archive = await db.send({ organization_id: 'org-a', storage: 'main', archive: { name: 'cold' }, method: 'archive.create' })
    assert.equal(archive.success, true, archive.error?.join('; '))
    assert.equal(archive.archive[0].parent, storage.uuid)
    assert.throws(() => db.config.setValue('roots.$organization_id.storage.archive', undefined), /occupied/)
    await db.send({method:'archive.delete',archive:{uuid:archive.archive[0].uuid}})
    db.config.setValue('roots.$organization_id.storage.archive', undefined)
    assert.equal(db.leaves.has(archive.archive[0].uuid), false)
    assert.equal((await db.send({ organization_id: 'org-a', storage: 'main', method: 'archive.read' })).success, false)

    const missingRead = await db.send({ organization_id: 'org-c', storage: 'none', database: 'none', array: 'none', method: 'object.read' })
    assert.equal(missingRead.success, true)
    assert.equal([...db.leaves.values()].some(a => a.name === 'org-c'), false)

    db.config.setValue('roots.status', {})
    const status = await db.send({ method: 'status.create', status: { name: 'ready' } })
    assert.equal(status.success, true, status.error?.join('; '))
    assert.equal(status.status[0].parent, undefined)
    assert.equal((await db.send({ method: 'storage.delete', organization_id: 'org-a', storage: { name: 'main' } })).success, false)
    assert.equal(db.leaves.has(user.uuid), true)
})

test('root resolution rejects missing organizations, bad refs and cyclic config', async () => {
    const db = createDB({ isPrimary: true })
    const missingOrg = await db.send({ method: 'object.create', storage: 'main', database: 'app', array: 'users', object: {} })
    assert.equal(missingOrg.success, false)
    const missingReference = await db.send({ method: 'object.create', organization_id: 'org', storage: { uuid: 'absent' }, database: 'app', array: 'users', object: {} })
    assert.equal(missingReference.success, false)
    const circular = {}
    circular.loop = circular
    assert.throws(() => db.config.setValue('roots', circular), /Cyclic root configuration/)
})

test('leaf capacity can be smaller than branch capacity', async () => {
    const db = createDB({}, { size: 16, leafSize: 4 })
    const root = { organization_id: 'org', storage: 'store', database: 'db', array: 'items' }
    const objects = Array.from({ length: 24 }, (_, sequence) => ({ sequence }))
    const created = await db.send({ ...root, method: 'object.create', object: objects })
    assert.equal(created.success, true)
    db.flushIndex()

    const tree = created.object[0].getIndex('sequence').tree
    assert.ok(tree.root.branches.length > 4)
    assert.ok(tree.root.branches.every(leaf => !leaf.branches && leaf.length <= 4))
    const read = await db.send({ ...root, method: 'object.read', filter: { query: { sequence: 23 } } })
    assert.equal(read.object[0], created.object[23])
})
