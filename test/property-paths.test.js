import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createIndex } from '../src/index/index.js'
import { queryIndexCandidates } from '../src/query.js'
import { flattenIndexValues, getPath, normalizeArrayContinuity, normalizeObject, writeExclusiveJSON, readJSON } from '../src/storage.js'
import { removeMemoryPath } from '../src/memory.js'
import { fileId, identify, newFileId } from '../src/files.js'

test('object indexes own nested properties, containers, and every continuous array position', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'coc-object-paths-'))
    t.after(async () => {
        removeMemoryPath(directory)
        await rm(directory, { recursive: true, force: true })
    })

    const record = identify({
        _id: 'logical-1',
        emptyObject: {},
        emptyArray: [],
        products: [
            { name: 'Laptop', price: 1000 },
            { name: 'Phone', price: 500 }
        ],
        roles: ['admin', undefined, null, { name: 'developer' }]
    }, newFileId())
    record.roles.length = 6
    record.roles[5] = ['nested']
    normalizeArrayContinuity(record)
    const objectId = fileId(record)
    const file = join(directory, 'data', objectId)
    await writeExclusiveJSON(file, record)

    const index = createIndex({ directory, indexRoot: directory, readIndexedValue: async ({ objectId: id, key }) => {
        const owner = await readJSON(join(directory, 'data', id))
        return owner && getPath(owner, key)
    } })
    for (const [path, value] of flattenIndexValues(record))
        await index.create('org', 'products', path, value, objectId)

    const paths = new Set(flattenIndexValues(record).map(([path]) => path))
    for (const path of [
        'emptyObject', 'emptyArray', 'products', 'products[0]', 'products[0].name',
        'products[0].price', 'products[1]', 'products[1].price',
        'roles[0]', 'roles[1]', 'roles[2]', 'roles[3].name', 'roles[4]', 'roles[5][0]'
    ]) assert.ok(paths.has(path), `missing object-index path ${path}`)
    const binaryPaths = new Set(flattenIndexValues({ payload: Buffer.from([1, 2]) }).map(([path]) => path))
    assert.ok(binaryPaths.has('payload'))
    assert.equal(binaryPaths.has('payload[0]'), false, 'binary views are indexed atomically')
    const ownedBinaryPaths = new Set(flattenIndexValues({
        file: 'binary[0]',
        binary: [{ $Uint8Array: new Uint8Array([1, 2]) }]
    }).map(([path]) => path))
    assert.equal(ownedBinaryPaths.has('file'), false,
        'references to binary metadata are not ordinary indexed values')
    assert.equal([...ownedBinaryPaths].some(path => path === 'binary' || path.startsWith('binary.')), false,
        'CoSON-owned binary metadata is excluded from database indexes')
    assert.ok(flattenIndexValues({ binary: ['user value'] }).some(([path]) => path === 'binary'),
        'ordinary user-defined binary fields remain indexable')

    const priceMatch = await queryIndexCandidates(index, 'org', 'products', { 'products[0].price': { $gte: 900 } })
    assert.deepEqual([...priceMatch.ids], [objectId])
    const member = await queryIndexCandidates(index, 'org', 'products', { roles: { $includes: 'admin' } })
    assert.deepEqual([...member.ids], [objectId])
    const undefinedMatch = await queryIndexCandidates(index, 'org', 'products', { 'roles[1]': { $eq: undefined } })
    assert.deepEqual([...undefinedMatch.ids], [objectId])
    const nullMatch = await queryIndexCandidates(index, 'org', 'products', { 'roles[2]': { $eq: null } })
    assert.deepEqual([...nullMatch.ids], [objectId])
    const reopened = createIndex({ directory, indexRoot: directory, readIndexedValue: async ({ objectId: id, key }) => {
        const owner = await readJSON(join(directory, 'data', id))
        return owner && getPath(owner, key)
    } })
    const objectValues = []
    for await (const entry of reopened.scan('org', 'products', 'products[0]', { type: 'object' })) objectValues.push(entry.value)
    assert.deepEqual(objectValues, [{ name: 'Laptop', price: 1000 }])
    const restored = await readJSON(file)
    assert.equal(Object.hasOwn(restored.roles, 1), true)
    assert.equal(restored.roles[1], undefined)
    assert.equal(restored.roles[2], null)
    assert.equal((await readdir(directory)).includes('keys'), false)
})

test('shared dot notation utilities flatten index entries and rebuild literal input paths', () => {
	const record = { uuid: 'artifact-id', profile: { city: 'Lima' }, empty: {}, list: [] }
	const fields = new Map(flattenIndexValues(record).filter(([key]) => !key.startsWith('\0exists:')))
	assert.equal(fields.get('profile'), record.profile)
	assert.equal(fields.get('profile.city'), 'Lima')
	assert.equal(fields.get('empty'), record.empty)
	assert.equal(fields.get('list'), record.list)
	assert.equal(fields.has('uuid'), false)

	const input = { 'profile.city': 'Paris', 'items[0].name': 'Phone', $internal: true }
	assert.equal(normalizeObject(input), input)
	assert.deepEqual(input, { profile: { city: 'Paris' }, items: [{ name: 'Phone' }] })
})
