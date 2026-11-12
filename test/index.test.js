import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createUpdate, queryData } from '@cocreate/utils'
import { createDistributionIndex, createIndex } from '../src/index.js'
import { createDB } from '../src/object/index.js'
import { queryIndexCandidates } from '../src/query.js'

const withIndex = async (run, options = {}) => {
    const directory = await mkdtemp(join(tmpdir(), 'cocreate-db-test-'))

    try {
        await run(createIndex({ directory, ...options }), directory)
    } finally {
        await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
}

const collect = async iterable => {
    const values = []

    for await (const value of iterable)
        values.push(value)

    return values
}

test('memoryCache keeps demand-cached CRUD reads coherent with disk', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cocreate-db-memory-'))
    try {
        const db = createDB({ directory, memoryCache: true })
        await db.ready
        assert.equal(db.memoryStats().files, 0)
        await db.send({ method: 'object.create', database: 'memory', array: 'items', object: { name: 'first' } })
        assert.ok(db.memoryStats().files > 0)
        const initial = await db.send({ method: 'object.read', database: 'memory', array: 'items' })
        const id = initial.object[0]._id
        await db.send({ method: 'object.update', database: 'memory', array: 'items', object: { _id: id, name: 'updated' } })
        assert.equal((await db.send({ method: 'object.read', database: 'memory', array: 'items' })).object[0].name, 'updated')
        await db.send({ method: 'object.delete', database: 'memory', array: 'items', object: { _id: id } })
        assert.equal((await db.send({ method: 'object.read', database: 'memory', array: 'items' })).object.length, 0)
        const reopened = createDB({ directory, memoryCache: true })
        await reopened.ready
        assert.ok(reopened.memoryStats().files > 0)
        assert.equal((await reopened.send({ method: 'object.read', database: 'memory', array: 'items' })).object.length, 0)
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

const resolveArrayDirectory = async (directory, database, array) => {
    const db = createDB({ directory })
    const databases = await db.send({ method: 'database.read' })
    const databaseId = databases.database.find(item => item.name === database)?._id
    const arrays = await db.send({ method: 'array.read', database })
    const arrayId = arrays.array.find(item => item.name === array)?._id

    assert.ok(databaseId, `missing database catalog entry: ${database}`)
    assert.ok(arrayId, `missing array catalog entry: ${array}`)
    return join(directory, 'databases', databaseId, 'arrays', arrayId)
}

const readCatalog = async (directory, database, array) => {
    const base = join(await resolveArrayDirectory(directory, database, array), 'index')
    const root = JSON.parse(await readFile(join(base, 'index.json'), 'utf8'))
    const keys = {}
    const visit = async node => {
        if (node.entries) {
            for (const [key, type, id] of node.entries) {
                keys[key] ??= {}
                keys[key][type] = id
            }
            return
        }
        for (const child of node.indexes ?? [])
            await visit(JSON.parse(await readFile(join(base, `${child.id}.json`), 'utf8')))
    }
    await visit(root)
    return { root, keys }
}

test('indexes object IDs and property values in deterministic order', async () => {
    await withIndex(async index => {
        const objects = [
            { _id: 'obj-3', age: 42, name: 'Zoe' },
            { _id: 'obj-1', age: 19, name: 'Ada' },
            { _id: 'obj-2', age: 19, name: 'Mina' }
        ]
        const objectsById = new Map(objects.map(object => [object._id, object]))

        for (const object of objects) {
            await index.set('test', 'users', '_id', object._id, object._id)
            await index.set('test', 'users', 'age', object.age, object._id)
            await index.set('test', 'users', 'name', object.name, object._id)
        }

        const ageEntries = await collect(index.scan('test', 'users', 'age', { type: 'number' }))

        assert.deepEqual(
            ageEntries,
            [
                { value: 19, objectId: 'obj-1' },
                { value: 19, objectId: 'obj-2' },
                { value: 42, objectId: 'obj-3' }
            ]
        )

        assert.deepEqual(
            ageEntries
                .filter(entry => entry.value === 19)
                .map(entry => objectsById.get(entry.objectId)),
            [objects[1], objects[2]]
        )

        assert.deepEqual(
            await collect(index.scan('test', 'users', 'name', { type: 'string', reverse: true })),
            [
                { value: 'Zoe', objectId: 'obj-3' },
                { value: 'Mina', objectId: 'obj-2' },
                { value: 'Ada', objectId: 'obj-1' }
            ]
        )

        assert.equal((await index.get('test', 'users', 'age')).indexes.number.length, 3)
    })
})

test('object.create writes documents and indexes under a configured filesystem root; object.read returns them', async () => {
    await withIndex(async (_index, directory) => {
        const db = createDB({ directory })
        const created = await db.send({
            method: 'object.create',
            organization_id: 'test-org',
            database: 'test-database',
            array: 'users',
            object: [
                { name: 'Ada', age: 31, active: true, nickname: null, tags: ['one', 'two'], 'profile.city': 'Lima' },
                { name: 'Mina', age: 28, active: false, nickname: 'Mimi', tags: ['two'], 'profile.city': 'Quito' }
            ]
        })

        assert.equal(created.success, true)
        assert.equal(created.object.length, 2)
        assert.match(created.object[0]._id, /^[0-9a-f]{24}$/)
        assert.deepEqual(created.object[0].profile, { city: 'Lima' })

        const arrayDirectory = await resolveArrayDirectory(directory, 'test-database', 'users')
        const objectFiles = await readdir(join(arrayDirectory, 'objects'))
        const indexDirectory = join(arrayDirectory, 'index')
        const nodeFiles = new Set((await readdir(indexDirectory)).filter(file => file !== 'index.json'))
        const { root: catalog, keys } = await readCatalog(directory, 'test-database', 'users')

        assert.equal(objectFiles.length, 2)
        assert.ok(keys._id.string)
        assert.ok(keys.name.string)
        assert.ok(keys.age.number)
        assert.ok(keys['profile.city'].string)
        assert.ok(keys.active.boolean)
        assert.ok(keys.nickname.null)
        assert.ok(keys.tags.array)
        assert.equal(keys.tags.string, undefined)
        for (const branches of Object.values(keys))
            for (const nodeId of Object.values(branches))
                assert.ok(nodeFiles.has(`${nodeId}.json`))

        const stored = JSON.parse(await readFile(
            join(arrayDirectory, 'objects', `${created.object[0]._id}.json`),
            'utf8'
        ))
        assert.equal(stored.name, 'Ada')
        assert.equal(stored.$storage, undefined)

        const reopened = createDB({ directory })
        const byId = await reopened.send({
            method: 'object.read',
            database: 'test-database',
            array: 'users',
            object: { _id: created.object[0]._id }
        })
        assert.equal(byId.success, true)
        assert.equal(byId.object.length, 1)
        assert.equal(byId.object[0].name, 'Ada')

        const byNestedIndex = await reopened.send({
            method: 'object.read',
            database: 'test-database',
            array: 'users',
            filter: { query: { 'profile.city': 'Quito' } }
        })
        assert.equal(byNestedIndex.success, true)
        assert.deepEqual(byNestedIndex.object.map(object => object.name), ['Mina'])

        const byArrayValue = await reopened.send({
            method: 'object.read',
            database: 'test-database',
            array: 'users',
            filter: { query: { tags: 'two' } }
        })
        assert.deepEqual(byArrayValue.object.map(object => object.name).sort(), ['Ada', 'Mina'])

        const byMultipleFields = await reopened.send({
            method: 'object.read',
            database: 'test-database',
            array: 'users',
            filter: { query: { age: 31, 'profile.city': 'Lima' } }
        })
        assert.deepEqual(byMultipleFields.object.map(object => object.name), ['Ada'])
    })
})

test('database and array catalogs resolve stable IDs, report lengths, rename, and cascade delete', async () => {
    await withIndex(async (_index, directory) => {
        const db = createDB({ directory })
        const createdDatabase = await db.send({ method: 'database.create', database: 'example' })
        assert.equal(createdDatabase.success, true, createdDatabase.error)
        assert.match(createdDatabase.database[0]._id, /^[0-9a-f]{24}$/)

        const createdArray = await db.send({ method: 'array.create', database: 'example', array: 'users' })
        assert.equal(createdArray.success, true, createdArray.error)
        assert.match(createdArray.array[0]._id, /^[0-9a-f]{24}$/)
        assert.equal(createdArray.array[0].length, 0)
        assert.equal('count' in createdArray.array[0], false)

        const createdObject = await db.send({
            method: 'object.create', database: 'example', array: 'users', object: { name: 'Ada' }
        })
        assert.equal(createdObject.success, true, createdObject.error)

        const databaseRead = await db.send({ method: 'database.read' })
        const database = databaseRead.database.find(item => item.name === 'example')
        assert.equal(database.arrayLength, 1)
        assert.equal(database.objectLength, 1)
        assert.equal('count' in database, false)
        assert.deepEqual(database.arrays.map(({ name, length }) => ({ name, length })), [
            { name: 'users', length: 1 }
        ])

        const arrayRename = await db.send({
            method: 'array.update', database: 'example', array: 'users', name: 'members',
            config: { encryptionAtRest: true }
        })
        assert.equal(arrayRename.success, true, arrayRename.error)
        assert.equal(arrayRename.array[0]._id, createdArray.array[0]._id)
        assert.deepEqual(arrayRename.array[0].config, { encryptionAtRest: true })
        assert.equal((await db.send({
            method: 'object.read', database: 'example', array: 'members', object: { _id: createdObject.object[0]._id }
        })).object[0].name, 'Ada')

        const databaseRename = await db.send({
            method: 'database.update', database: 'example', name: 'renamed',
            config: { encryptionAtRest: false }
        })
        assert.equal(databaseRename.success, true, databaseRename.error)
        assert.equal(databaseRename.database[0]._id, createdDatabase.database[0]._id)
        assert.equal(databaseRename.database[0].arrays[0].name, 'members')
        assert.deepEqual(databaseRename.database[0].config, { encryptionAtRest: false })

        const deletedArray = await db.send({ method: 'array.delete', database: 'renamed', array: 'members' })
        assert.equal(deletedArray.success, true, deletedArray.error)
        assert.equal(deletedArray.array[0].length, 1)
        assert.deepEqual((await db.send({ method: 'array.read', database: 'renamed' })).array, [])

        const deletedDatabase = await db.send({ method: 'database.delete', database: 'renamed' })
        assert.equal(deletedDatabase.success, true, deletedDatabase.error)
        assert.equal(deletedDatabase.database[0]._id, createdDatabase.database[0]._id)
        assert.deepEqual((await db.send({ method: 'database.read' })).database, [])
    })
})

test('database and array reads migrate legacy count fields to persisted length metadata', async () => {
    await withIndex(async (_index, directory) => {
        const db = createDB({ directory })
        const database = (await db.send({ method: 'database.create', database: 'legacy-lengths' })).database[0]
        const array = (await db.send({ method: 'array.create', database: 'legacy-lengths', array: 'items' })).array[0]
        await db.send({ method: 'object.create', database: 'legacy-lengths', array: 'items', object: { value: 1 } })

        const databaseFile = join(directory, 'databases', database._id, 'database.json')
        const arrayFile = join(directory, 'databases', database._id, 'arrays', array._id, 'array.json')
        const databaseMetadata = JSON.parse(await readFile(databaseFile, 'utf8'))
        const arrayMetadata = JSON.parse(await readFile(arrayFile, 'utf8'))
        databaseMetadata.count = databaseMetadata.arrayLength
        databaseMetadata.objectCount = databaseMetadata.objectLength
        delete databaseMetadata.arrayLength
        delete databaseMetadata.objectLength
        arrayMetadata.count = arrayMetadata.length
        delete arrayMetadata.length
        await writeFile(databaseFile, JSON.stringify(databaseMetadata))
        await writeFile(arrayFile, JSON.stringify(arrayMetadata))

        const read = await db.send({ method: 'database.read' })
        const migratedDatabase = read.database.find(record => record.name === 'legacy-lengths')
        assert.equal(migratedDatabase.arrayLength, 1)
        assert.equal(migratedDatabase.objectLength, 1)
        assert.equal('count' in migratedDatabase, false)
        assert.equal('objectCount' in migratedDatabase, false)
        assert.equal(migratedDatabase.arrays[0].length, 1)
        assert.equal('count' in migratedDatabase.arrays[0], false)

        const persistedDatabase = JSON.parse(await readFile(databaseFile, 'utf8'))
        const persistedArray = JSON.parse(await readFile(arrayFile, 'utf8'))
        assert.equal(persistedDatabase.arrayLength, 1)
        assert.equal(persistedDatabase.objectLength, 1)
        assert.equal('count' in persistedDatabase, false)
        assert.equal('objectCount' in persistedDatabase, false)
        assert.equal(persistedArray.length, 1)
        assert.equal('count' in persistedArray, false)
    })
})

test('queries an ordered alphabet matrix with exact case and distinct number/string value types', async () => {
    await withIndex(async (_index, directory) => {
        const db = createDB({ directory })
        const alphabet = 'abcdefghi'
        const columns = Array.from({ length: 9 }, (_, i) => `field${String.fromCharCode(65 + i)}`)
        const objects = []

        for (const uppercase of [false, true]) {
            for (let row = 0; row < alphabet.length; row++) {
                const sequence = row + 1 + (uppercase ? 9 : 0)
                const object = {
                    sequence,
                    number: row + 1,
                    numberString: String(row + 1),
                    mixedRangeValue: uppercase ? String(row + 1) : row + 1,
                    letter: uppercase ? alphabet[row].toUpperCase() : alphabet[row],
                    typedValue: !uppercase && row === 8 ? 9 : uppercase && row === 8 ? '9' : 'other',
                    tags: row % 2 ? ['red'] : ['red', 'blue'],
                    'profile.city': uppercase ? 'LIMA' : 'Lima',
                    ...(row % 2 ? {} : { optional: true })
                }

                columns.forEach((key, column) => {
                    const value = alphabet[(row + column) % alphabet.length]
                    object[key] = uppercase ? value.toUpperCase() : value
                })

                objects.push(object)
            }
        }

        const created = await db.send({
            method: 'object.create', database: 'query-matrix', array: 'items', object: objects
        })
        assert.equal(created.success, true, created.error)
        assert.equal(created.object.length, 18)

        const query = async conditions => {
            const response = await db.send({
                method: 'object.read', database: 'query-matrix', array: 'items',
                filter: { query: conditions }
            })
            assert.equal(response.success, true, response.error)
            return response.object.map(object => object.sequence).sort((a, b) => a - b)
        }

        for (let column = 0; column < columns.length; column++) {
            for (let letter = 0; letter < alphabet.length; letter++) {
                const row = (letter - column + alphabet.length) % alphabet.length
                const lower = row + 1
                const upper = row + 10

                assert.deepEqual(await query({ [columns[column]]: alphabet[letter] }), [lower])
                assert.deepEqual(await query({ [columns[column]]: alphabet[letter].toUpperCase() }), [upper])
            }
        }

        assert.deepEqual(await query({ letter: 'a' }), [1])
        assert.deepEqual(await query({ letter: 'A' }), [10])
        assert.deepEqual(await query({ typedValue: 9 }), [9])
        assert.deepEqual(await query({ typedValue: '9' }), [18])
        assert.deepEqual(await query({ number: 9 }), [9, 18])
        assert.deepEqual(await query({ numberString: '9' }), [9, 18])
        assert.deepEqual(await query({ mixedRangeValue: { $gt: 8 } }), [9, 18])
        assert.deepEqual(await query({ mixedRangeValue: { $gt: '8' } }), [9, 18])
        assert.deepEqual(await query({ fieldA: 'a', number: 1 }), [1])

        assert.deepEqual(await query([
            { key: 'number', value: 6, operator: '$gt' }
        ]), [7, 8, 9, 16, 17, 18])
        assert.deepEqual(await query([
            { key: 'number', value: 8, operator: '$gte' }
        ]), [8, 9, 17, 18])
        assert.deepEqual(await query([
            { key: 'number', value: 3, operator: '$lt' }
        ]), [1, 2, 10, 11])
        assert.deepEqual(await query([
            { key: 'number', value: 2, operator: '$lte' }
        ]), [1, 2, 10, 11])
        assert.deepEqual(await query([
            { key: 'number', value: 9, operator: '$ne' }
        ]), [1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17])

        const sharedQueryCases = [
            { number: { $in: [1, 9] } },
            { number: { $nin: [1, 9] } },
            { number: { $gte: 4, $lt: 7 } },
            { $and: [{ number: { $gt: 2 } }, { number: { $lte: 4 } }] },
            { $or: [{ letter: 'a' }, { letter: 'I' }] },
            { tags: { $all: ['red', 'blue'] } },
            { tags: { $size: 1 } },
            { tags: { $elemMatch: { $eq: 'blue' } } },
            { 'profile.city': { $regex: '^LI', $options: 'i' } },
            { optional: { $exists: true } },
            { number: { $mod: [2, 0] } },
            { $nor: [{ number: 1 }, { letter: 'A' }] },
            { number: { $not: { $gt: 7 } } },
            { number: { $type: 'number' } }
        ]

        for (const queryDataFilter of sharedQueryCases) {
            const expected = created.object
                .filter(object => queryData(object, queryDataFilter))
                .map(object => object.sequence)
                .sort((a, b) => a - b)
            assert.deepEqual(await query(queryDataFilter), expected, JSON.stringify(queryDataFilter))
        }
    })
})

test('object.update applies shared update operators and keeps all affected index entries current', async () => {
    await withIndex(async (_index, directory) => {
        const db = createDB({ directory })
        const created = await db.send({
            method: 'object.create', database: 'shared-utils', array: 'items',
            object: {
                name: 'Ada', score: 1, tags: ['red'], items: ['a', 'b', 'c'],
                oldName: 'Ada', removeMe: true, removeArray: ['x'], category: 'old',
                'profile.city': 'Lima'
            }
        })
        assert.equal(created.success, true)
        const current = created.object[0]
        const attemptedIdChange = await db.send({
            method: 'object.update', database: 'shared-utils', array: 'items',
            object: { _id: current._id, $set: { _id: '000000000000000000000000' } }
        })
        assert.equal(attemptedIdChange.success, false)

        const update = {
            $inc: { score: 2 },
            $push: { tags: 'blue' },
            $addToSet: { tags: 'green' },
            $pull: { tags: 'red' },
            $rename: { name: 'label' },
            $unset: { 'profile.city': true },
            $each: { items: ['d', 'e'] },
            $splice: { items: 'f' },
            $pop: { items: true },
            $shift: { items: true },
            $delete: { removeMe: true },
            $slice: { removeArray: true },
            $set: { category: 'new' }
        }
        const sharedUpdate = { ...update, ...update.$set }
        delete sharedUpdate.$set
        const expected = createUpdate({
            _id: current._id,
            name: current.name,
            score: current.score,
            tags: [...current.tags],
            items: [...current.items],
            oldName: current.oldName,
            removeMe: current.removeMe,
            removeArray: [...current.removeArray],
            category: current.category,
            profile: { ...current.profile },
            created: current.created,
            updated: current.updated
        }, sharedUpdate)

        const result = await db.send({
            method: 'object.update', database: 'shared-utils', array: 'items',
            object: { _id: current._id, ...update }
        })
        assert.equal(result.success, true, result.error)
        assert.equal(result.object[0].$set.score, expected.score)
        assert.equal(result.object[0].$set.label, expected.label)
        assert.deepEqual(result.object[0].$set.tags, expected.tags)
        assert.deepEqual(result.object[0].$set.items, expected.items)
        assert.equal(result.object[0].$set['profile.name'], expected.profile.name)
        assert.equal(result.object[0].name, undefined)
        assert.equal(result.object[0].removeMe, undefined)
        assert.equal(result.object[0].removeArray, undefined)
        assert.equal(result.object[0].$set.category, expected.category)

        assert.deepEqual((await db.send({
            method: 'object.read', database: 'shared-utils', array: 'items',
            filter: { query: { score: 3, label: 'Ada', tags: 'green' } }
        })).object.map(object => object._id), [current._id])
        assert.deepEqual((await db.send({
            method: 'object.read', database: 'shared-utils', array: 'items',
            filter: { query: { name: 'Ada' } }
        })).object, [])
        assert.deepEqual((await db.send({
            method: 'object.read', database: 'shared-utils', array: 'items',
            filter: { query: { tags: 'red' } }
        })).object, [])

        const globalUpdate = await db.send({
            method: 'object.update', database: 'shared-utils', array: 'items',
            object: { _id: current._id },
            $inc: { score: 1 }
        })
        assert.equal(globalUpdate.success, true, globalUpdate.error)
        assert.equal(globalUpdate.object[0].$set.score, 4)
        assert.deepEqual((await db.send({
            method: 'object.read', database: 'shared-utils', array: 'items',
            filter: { query: { score: 4 } }
        })).object.map(object => object._id), [current._id])
    })
})

test('indexes booleans and null in separate type branches', async () => {
    await withIndex(async index => {
        await index.set('test', 'users', 'active', true, 'obj-1')
        await index.set('test', 'users', 'active', false, 'obj-2')
        await index.set('test', 'users', 'nickname', null, 'obj-1')
        await index.set('test', 'users', 'score', 10, 'obj-1')
        await index.set('test', 'users', 'score', 10, 'obj-1')
        await index.set('test', 'users', 'score', 10, 'obj-2')

        assert.deepEqual(
            await collect(index.scan('test', 'users', 'score', { type: 'number' })),
            [
                { value: 10, objectId: 'obj-1' },
                { value: 10, objectId: 'obj-2' }
            ]
        )

        assert.deepEqual(
            await collect(index.scan('test', 'users', 'active', { type: 'boolean' })),
            [
                { value: false, objectId: 'obj-2' },
                { value: true, objectId: 'obj-1' }
            ]
        )
        assert.deepEqual(
            await collect(index.scan('test', 'users', 'nickname', { type: 'null' })),
            [{ value: null, objectId: 'obj-1' }]
        )
    })
})

test('index entries survive cache clearing and reopening the filesystem index', async () => {
    await withIndex(async (index, directory) => {
        await index.set('test', 'users', 'age', 30, 'obj-1')
        index.clearCache()

        const reopened = createIndex({ directory })

        assert.deepEqual(
            await collect(reopened.scan('test', 'users', 'age', { type: 'number' })),
            [{ value: 30, objectId: 'obj-1' }]
        )
    })
})

test('splits a growing index, scans it in both directions, and prunes it after deletion', async () => {
    await withIndex(async index => {
        const entries = Array.from({ length: 100 }, (_, i) => ({
            value: i,
            objectId: `object-${String(i).padStart(3, '0')}`
        }))

        for (const entry of entries)
            await index.set('test', 'items', 'rank', entry.value, entry.objectId)

        const forward = await collect(index.scan('test', 'items', 'rank', { type: 'number' }))
        const reverse = await collect(index.scan('test', 'items', 'rank', { type: 'number', reverse: true }))

        assert.equal(forward.length, entries.length)
        assert.deepEqual(forward, entries.map(({ value, objectId }) => ({ value, objectId })))
        assert.deepEqual(reverse, [...forward].reverse())

        for (const entry of entries)
            assert.equal(await index.remove('test', 'items', 'rank', entry.value, entry.objectId), true)

        assert.deepEqual(await collect(index.scan('test', 'items', 'rank')), [])
        assert.deepEqual((await index.get('test', 'items', 'rank')).indexes, {})
    }, { maxBytes: 512 })
})

test('splits the catalog root into 32-character hexadecimal files and resolves catalog entries through multiple levels', async () => {
    await withIndex(async (index, directory) => {
        const fields = Array.from({ length: 160 }, (_, i) => `field-${String(i).padStart(3, '0')}`)

        for (let i = 0; i < fields.length; i++)
            await index.set('test', 'catalog', fields[i], i, 'object-1')

        const indexDirectory = join(directory, 'test', 'catalog', 'index')
        const root = JSON.parse(await readFile(join(indexDirectory, 'index.json'), 'utf8'))
        assert.ok(root.indexes, 'overflowed catalog root should point to child 32-character hexadecimal files')
        assert.equal(root.entries, undefined)
        assert.equal(root.catalogLength, fields.length)
        assert.ok(Buffer.byteLength(JSON.stringify(root)) <= 512)
        const depth = async node => node.entries
            ? 1
            : 1 + Math.max(...await Promise.all(node.indexes.map(async child =>
                depth(JSON.parse(await readFile(join(indexDirectory, `${child.id}.json`), 'utf8')))
            )))
        assert.ok(await depth(root) >= 3, 'catalog root should grow another level when its references overflow')

        for (let i = 0; i < fields.length; i++) {
            const found = await index.get('test', 'catalog', fields[i])
            assert.equal(found.indexes.number.length, 1)
            assert.deepEqual(
                await collect(index.scan('test', 'catalog', fields[i], { type: 'number' })),
                [{ value: i, objectId: 'object-1' }]
            )
        }

        const catalogFiles = (await readdir(indexDirectory)).filter(file => file !== 'index.json')
        assert.ok(catalogFiles.length > fields.length, 'catalog splits should add 32-character hexadecimal files alongside field nodes')

        for (let i = 0; i < fields.length; i++)
            await index.remove('test', 'catalog', fields[i], i, 'object-1')

        const emptyRoot = JSON.parse(await readFile(join(indexDirectory, 'index.json'), 'utf8'))
        assert.deepEqual(emptyRoot.entries, [])
        assert.equal(emptyRoot.catalogLength, 0)
        assert.deepEqual((await readdir(indexDirectory)).sort(), ['index.json'])
    }, { maxBytes: 512 })
})

test('migrates a legacy flat catalog when the next key root is written', async () => {
    await withIndex(async (index, directory) => {
        const indexDirectory = join(directory, 'test', 'users', 'index')
        await mkdir(indexDirectory, { recursive: true })
        await writeFile(join(indexDirectory, 'index.json'), JSON.stringify({
            count: 1,
            keys: { age: { number: 'legacy-root' } }
        }))
        await writeFile(join(indexDirectory, 'legacy-root.json'), JSON.stringify({
            id: 'legacy-root',
            entries: [[31, 'object-1']],
            count: 1,
            first: { value: 31, objectId: 'object-1' },
            last: { value: 31, objectId: 'object-1' }
        }))

        await index.set('test', 'users', 'name', 'Ada', 'object-1')

        assert.deepEqual(
            await collect(index.scan('test', 'users', 'age', { type: 'number' })),
            [{ value: 31, objectId: 'object-1' }]
        )
        assert.deepEqual(
            await collect(index.scan('test', 'users', 'name', { type: 'string' })),
            [{ value: 'Ada', objectId: 'object-1' }]
        )
        const root = JSON.parse(await readFile(join(indexDirectory, 'index.json'), 'utf8'))
        assert.equal(root.keys, undefined)
        assert.ok(root.entries || root.indexes)
        assert.equal(root.length, 1)
    })
})

test('rejects invalid logical path components and unsupported indexed values', async () => {
    await withIndex(async index => {
        await assert.rejects(index.set('../escape', 'users', 'age', 20, 'obj-1'), /Invalid database or array name/)
        await assert.rejects(index.set('test', 'users', 'age', Infinity, 'obj-1'), /Only finite numbers/)
        await assert.rejects(index.set('test', 'users', 'age', 20, 1), /objectId must be a string/)
    })
})

test('object.update changes indexed fields and unsets nested fields without changing object count', async () => {
    await withIndex(async (_index, directory) => {
        const db = createDB({ directory })
        const created = await db.send({
            method: 'object.create', database: 'test', array: 'users',
            object: [
                { name: 'Ada', age: 31, nickname: 'A', profile: { city: 'Lima' }, temporary: 'remove-me' },
                { name: 'Mina', age: 28, profile: { city: 'Quito' } }
            ]
        })
        assert.equal(created.success, true)
        const [ada] = created.object
        const catalogFile = join(await resolveArrayDirectory(directory, 'test', 'users'), 'index', 'index.json')

        const updated = await db.send({
            method: 'object.update', database: 'test', array: 'users',
            object: { _id: ada._id, age: 32, 'profile.city': 'Cusco', $unset: { nickname: 1, temporary: 1 } }
        })
        assert.equal(updated.success, true, updated.error)
        assert.equal(updated.object[0].$set.age, 32)
        assert.equal(updated.object[0].$set['profile.city'], 'Cusco')
        assert.equal('nickname' in updated.object[0], false)

        const { root: catalog, keys } = await readCatalog(directory, 'test', 'users')
        assert.equal(catalog.length, 2)
        assert.equal(keys.temporary, undefined)
        assert.equal(keys.nickname, undefined)
        assert.equal((await db.send({
            method: 'object.read', database: 'test', array: 'users', filter: { query: { age: 31 } }
        })).object.length, 0)
        assert.deepEqual((await db.send({
            method: 'object.read', database: 'test', array: 'users', filter: { query: { age: 32, 'profile.city': 'Cusco' } }
        })).object.map(object => object._id), [ada._id])
        assert.deepEqual((await db.send({
            method: 'object.read', database: 'test', array: 'users', filter: { query: { 'profile.city': 'Lima' } }
        })).object, [])
    })
})

test('object.update upserts a filtered record and creates its database and array', async () => {
    await withIndex(async (_index, directory) => {
        const db = createDB({ directory })
        const first = await db.send({
            method: 'object.update', database: 'dev', array: 'files',
            filter: { query: { pathname: '/robots.txt' } },
            object: { name: 'robots.txt', pathname: '/robots.txt', src: 'first version' },
            upsert: true
        })

        assert.equal(first.success, true, first.error)
        assert.equal(first.object.length, 1)
        assert.equal(first.object[0].pathname, '/robots.txt')
        assert.equal(first.object[0].src, 'first version')

        const second = await db.send({
            method: 'object.update', database: 'dev', array: 'files',
            filter: { query: { pathname: '/robots.txt' } },
            object: { name: 'robots.txt', pathname: '/robots.txt', src: 'updated version' },
            upsert: true
        })

        assert.equal(second.success, true, second.error)
        assert.equal(second.object.length, 1)
        assert.equal(second.object[0]._id, first.object[0]._id)
        assert.equal(second.object[0].$set.src, 'updated version')

        const read = await db.send({
            method: 'object.read', database: 'dev', array: 'files',
            filter: { query: { pathname: '/robots.txt' } }
        })
        assert.equal(read.object.length, 1)
        assert.equal(read.object[0].src, 'updated version')

        const databases = await db.send({ method: 'database.read' })
        const database = databases.database.find(item => item.name === 'dev')
        assert.equal(database.objectLength, 1)
        assert.equal(database.arrayLength, 1)
        assert.equal(database.arrays[0].name, 'files')
        assert.equal(database.arrays[0].length, 1)
    })
})

test('object.update upserts a missing object with an explicit ID', async () => {
    await withIndex(async (_index, directory) => {
        const db = createDB({ directory })
        const object = {
            _id: '6a6152c3007efd2634580623',
            master: { status: 'running' },
            worker1: { status: 'running' }
        }
        const response = await db.send({
            method: 'object.update',
            database: 'platform',
            array: 'servers',
            object,
            upsert: true
        })

        assert.equal(response.success, true, response.error)
        assert.equal(response.object.length, 1)
        assert.equal(response.object[0]._id, object._id)
        assert.deepEqual(response.object[0].master, object.master)

        const read = await db.send({
            method: 'object.read',
            database: 'platform',
            array: 'servers',
            object: { _id: object._id }
        })
        assert.equal(read.object.length, 1)
    })
})

test('object.read plans AND/OR queries, sorts multiple keys, projects fields, and returns source paging metadata', async () => {
    await withIndex(async (_index, directory) => {
        const db = createDB({ directory })
        const created = await db.send({
            method: 'object.create', database: 'test', array: 'users',
            object: [
                { name: 'Ada', team: 'red', score: 31, active: false, hidden: 'a' },
                { name: 'Bea', team: 'blue', score: 24, active: false, hidden: 'b' },
                { name: 'Cal', team: 'blue', score: 18, active: true, hidden: 'c' },
                { name: 'Dee', team: 'red', score: 24, active: false, hidden: 'd' }
            ]
        })
        assert.equal(created.success, true, created.error)

        const response = await db.send({
            method: 'object.read', database: 'test', array: 'users',
            filter: {
                query: {
                    $and: [
                        { score: { $gte: 20 } },
                        { $or: [{ team: 'red' }, { name: 'Bea' }] }
                    ]
                },
                sort: [{ key: 'score', direction: 'desc' }, { key: 'name', direction: 'asc' }],
                key: { name: 1, score: 1, _id: 0 },
                index: 0,
                limit: 2
            }
        })

        assert.equal(response.success, true, response.error)
        assert.deepEqual(response.object.map(({ name, score }) => ({ name, score })), [
            { name: 'Ada', score: 31 },
            { name: 'Bea', score: 24 }
        ])
        assert.equal(response.object[0]._id, undefined)
        assert.equal(response.object[0].hidden, undefined)
        const source = response.filter.storages.find(item => item.storage === 'db')
        assert.equal(source.count, 3)
        assert.equal(source.startingIndex, 0)
        assert.equal(source.index, 2)

        const noMatch = await db.send({
            method: 'object.read', database: 'test', array: 'users',
            filter: { query: { $or: [{ team: 'green' }, { name: 'missing' }] } }
        })
        assert.equal(noMatch.success, true, noMatch.error)
        assert.deepEqual(noMatch.object, [])
    })
})

test('query planning narrows candidates before checking a broad array membership predicate', async () => {
    let hostArrayScans = 0
    const index = {
        get: async (_database, _array, key) => ({
            indexes: key === 'host'
                ? { array: { length: 1000 } }
                : key === 'pathname'
                    ? { string: { length: 1000 } }
                    : {}
        }),
        scan: async function* (_database, _array, key, { type } = {}) {
            if (key === 'pathname' && type === 'string')
                yield { value: '/index.html', objectId: 'matching-document' }
            if (key === 'host' && type === 'array') {
                hostArrayScans++
                yield { value: ['*'], objectId: 'matching-document' }
            }
        }
    }
    const loaded = []
    const result = await queryIndexCandidates(index, 'dev', 'files', {
        host: { $in: ['dev.cocreatejs.com', '*'] },
        pathname: '/index.html'
    }, {
        readObject: async objectId => {
            loaded.push(objectId)
            return { _id: objectId, host: ['*'], pathname: '/index.html' }
        }
    })

    assert.deepEqual([...result.ids], ['matching-document'])
    assert.deepEqual(loaded, ['matching-document'])
    assert.equal(hostArrayScans, 0)
})

test('arrays are indexed as complete terminal values and query semantics remain shared', async () => {
    await withIndex(async (_index, directory) => {
        const db = createDB({ directory, maxIndexBytes: 512 })
        const created = await db.send({
            method: 'object.create',
            database: 'array-values',
            array: 'items',
            object: {
                user: { profile: { country: 'Panama' } },
                tags: ['javascript', 'database', ['nested', 'array']],
                projects: [
                    { name: 'CoCreateDB', status: 'active' },
                    { name: 'CoCreateJS', status: 'development' }
                ]
            }
        })
        const objectId = created.object[0]._id
        const keys = await db.index.get('array-values', 'items', 'tags')
        const nestedArrayKeys = await db.index.get('array-values', 'items', 'projects.name')
        assert.ok(keys.indexes.array)
        assert.deepEqual(nestedArrayKeys.indexes, {})

        const indexedTags = []
        for await (const entry of db.index.scan('array-values', 'items', 'tags', { type: 'array' }))
            indexedTags.push(entry)
        assert.equal(indexedTags.length, 1)
        assert.deepEqual(indexedTags[0].value, ['javascript', 'database', ['nested', 'array']])

        const membership = await db.send({
            method: 'object.read', database: 'array-values', array: 'items',
            filter: { query: { tags: 'javascript' } }
        })
        assert.equal(membership.object[0]._id, objectId)

        const allValues = await db.send({
            method: 'object.read', database: 'array-values', array: 'items',
            filter: { query: { tags: { $all: ['javascript', 'database'] } } }
        })
        assert.equal(allValues.object[0]._id, objectId)

        const size = await db.send({
            method: 'object.read', database: 'array-values', array: 'items',
            filter: { query: { tags: { $size: 3 } } }
        })
        assert.equal(size.object[0]._id, objectId)

        const elementMatch = await db.send({
            method: 'object.read', database: 'array-values', array: 'items',
            filter: { query: { projects: { $elemMatch: { name: 'CoCreateJS', status: 'development' } } } }
        })
        assert.equal(elementMatch.object[0]._id, objectId)

        const bracketPath = await db.send({
            method: 'object.read', database: 'array-values', array: 'items',
            filter: { query: { 'projects[0].name': 'CoCreateDB' } }
        })
        assert.equal(bracketPath.object[0]._id, objectId)

        const bracketProjection = await db.send({
            method: 'object.read', database: 'array-values', array: 'items',
            filter: { key: { 'projects[0].name': 1 } }
        })
        assert.deepEqual(bracketProjection.object[0].projects, [{ name: 'CoCreateDB' }])

        const bracketExclusion = await db.send({
            method: 'object.read', database: 'array-values', array: 'items',
            filter: { key: { 'projects[0].status': 0 } }
        })
        assert.equal(bracketExclusion.object[0].projects[0].status, undefined)
        assert.equal(bracketExclusion.object[0].projects[1].status, 'development')

        await db.send({
            method: 'object.update', database: 'array-values', array: 'items',
            object: { _id: objectId, tags: ['database', 'javascript', ['nested', 'array']] }
        })
        const updatedArray = await db.send({
            method: 'object.read', database: 'array-values', array: 'items',
            filter: { query: { tags: 'javascript' }, key: { 'user.profile.country': 1 } }
        })
        assert.deepEqual(updatedArray.object[0].user, { profile: { country: 'Panama' } })
        assert.equal((await db.index.get('array-values', 'items', 'tags[0]')).indexes.string, undefined)
    })
})

test('large terminal array values stay outside bounded index nodes and survive scans', async () => {
    await withIndex(async (_index, directory) => {
        const index = createIndex({ directory, maxBytes: 512 })
        const array = Array.from({ length: 2000 }, (_, position) => `value-${position}-${'x'.repeat(32)}`)
        await index.set('large-arrays', 'items', 'values', array, 'document-1')

        const [entry] = await collect(index.scan('large-arrays', 'items', 'values', { type: 'array' }))
        assert.deepEqual(entry.value, array)

        const indexDirectory = join(directory, 'large-arrays', 'items', 'index')
        const inspect = async path => {
            const files = await readdir(path, { withFileTypes: true })
            const sizes = []
            for (const file of files) {
                const target = join(path, file.name)
                if (file.isDirectory()) sizes.push(...await inspect(target))
                else if (file.name.endsWith('.json')) sizes.push({ path: target, size: (await stat(target)).size })
            }
            return sizes
        }
        const nodeSizes = await inspect(indexDirectory)
        const indexNodes = nodeSizes.filter(file => !file.path.includes(`${join('values', '')}`))
        const storedValues = nodeSizes.filter(file => file.path.includes(`${join('values', '')}`))
        assert.ok(indexNodes.length > 0)
        assert.ok(indexNodes.every(file => file.size <= 512))
        assert.ok(storedValues.length > 1)
        assert.ok(storedValues.every(file => file.size <= 512))
    })
})

test('maintains database, array, and document availability on local CRUD transitions', async () => {
    await withIndex(async (_index, directory) => {
        const events = []
        let db
        db = createDB({
            directory,
            nodeId: 'server-local',
            distributionAdapter: {
                onLocalChange: async event => {
                    events.push(event)
                    return db.updateDistribution(event)
                }
            }
        })

        const database = await db.send({ method: 'database.create', database: 'availability' })
        assert.equal(database.success, true, database.error)
        assert.deepEqual(await db.getDistribution({ database: 'availability' }), ['server-local'])

        const array = await db.send({ method: 'array.create', database: 'availability', array: 'items' })
        assert.equal(array.success, true, array.error)
        assert.deepEqual(await db.getDistribution({ database: 'availability', array: 'items' }), ['server-local'])

        const created = await db.send({
            method: 'object.create', database: 'availability', array: 'items',
            object: { name: 'Ada' }
        })
        assert.equal(created.success, true, created.error)
        assert.deepEqual(await db.getDistribution({
            database: 'availability', array: 'items', objectId: created.object[0]._id
        }), ['server-local'])

        const eventCount = events.length
        await db.send({ method: 'object.read', database: 'availability', array: 'items' })
        await db.send({
            method: 'object.update', database: 'availability', array: 'items',
            object: { _id: created.object[0]._id, name: 'Ada Lovelace' }
        })
        assert.equal(events.length, eventCount)

        const deleted = await db.send({
            method: 'object.delete', database: 'availability', array: 'items',
            object: { _id: created.object[0]._id }
        })
        assert.equal(deleted.success, true, deleted.error)
        assert.deepEqual(await db.getDistribution({
            database: 'availability', array: 'items', objectId: created.object[0]._id
        }), [])
        assert.equal(events.at(-1).operation, 'remove')
    })
})

test('Distribution Index scopes duplicate object IDs and deduplicates node references', async () => {
    await withIndex(async (_index, directory) => {
        const db = createDB({ directory })
        const database = await db.send({ method: 'database.create', database: 'scope-a' })
        const firstArray = await db.send({ method: 'array.create', database: 'scope-a', array: 'one' })
        const secondArray = await db.send({ method: 'array.create', database: 'scope-a', array: 'two' })
        const sameId = '000000000000000000000001'
        const first = {
            databaseId: database.database[0]._id,
            arrayId: firstArray.array[0]._id,
            objectId: sameId,
            nodeId: 'node-a',
            operation: 'add'
        }
        const second = { ...first, arrayId: secondArray.array[0]._id, nodeId: 'node-b' }

        assert.equal((await db.updateDistribution(first)).changed, true)
        assert.equal((await db.updateDistribution(first)).changed, false)
        assert.equal((await db.updateDistribution({ ...first, nodeId: 'node-c' })).changed, true)
        assert.equal((await db.updateDistribution(second)).changed, true)
        assert.deepEqual(await db.getDistribution(first), ['node-a', 'node-c'])
        assert.deepEqual(await db.getDistribution(second), ['node-b'])
        assert.deepEqual(await db.updateDistribution({ ...first, operation: 'remove', nodeId: 'node-a' }), {
            changed: true,
            nodeIds: ['node-c']
        })
    })
})

test('Distribution Index tracks holders of individual bounded index partitions', async () => {
    await withIndex(async (_, directory) => {
        const distribution = createDistributionIndex({ directory, maxBytes: 1024 })
        const partitionId = 'databases/db-id/arrays/array-id/index/age-root.json'

        assert.deepEqual(await distribution.getPartition(partitionId), [])
        assert.deepEqual(await distribution.updatePartition({
            partitionId, nodeId: 'node-a', operation: 'add'
        }), { changed: true, nodeIds: ['node-a'] })
        assert.deepEqual(await distribution.updatePartition({
            partitionId, nodeId: 'node-b', operation: 'add'
        }), { changed: true, nodeIds: ['node-a', 'node-b'] })
        assert.deepEqual(await distribution.updatePartition({
            partitionId, nodeId: 'node-a', operation: 'add'
        }), { changed: false, nodeIds: ['node-a', 'node-b'] })
        assert.deepEqual(await distribution.listPartitions(), [
            { partitionId, nodeIds: ['node-a', 'node-b'] }
        ])
        assert.deepEqual(await distribution.updatePartition({
            partitionId, nodeId: 'node-a', operation: 'remove'
        }), { changed: true, nodeIds: ['node-b'] })

        const catalog = JSON.parse(await readFile(join(directory, 'distribution', 'partitions', 'index', 'index.json'), 'utf8'))
        assert.ok(catalog.entries.length > 0)
        const reopened = createDistributionIndex({ directory, maxBytes: 1024 })
        assert.deepEqual(await reopened.getPartition(partitionId), ['node-b'])
    })
})

test('CRUD writes register recursive index root and node files as locally held partitions', async () => {
    await withIndex(async (_, directory) => {
        const db = createDB({ directory, nodeId: 'node-local' })
        const created = await db.send({
            method: 'object.create',
            database: 'partition-db',
            array: 'users',
            object: { name: 'Ada', age: 37 }
        })
        assert.equal(created.success, true, created.error)

        const partitions = await db.listPartitions()
        assert.ok(partitions.length > 0)
        assert.ok(partitions.every(({ nodeIds }) => nodeIds.includes('node-local')))
        assert.ok(partitions.some(({ partitionId }) => partitionId.endsWith('/index/index.json')))
        assert.ok(partitions.some(({ partitionId }) => /\/index\/[a-f0-9]{32}\.json$/i.test(partitionId)))
        assert.ok(partitions.every(({ partitionId }) => !partitionId.includes('/values/')))
    })
})

test('object.read resolves cold database and array names, fetches full documents by stable IDs, then projects', async () => {
    await withIndex(async (_remoteIndex, remoteDirectory) => {
        const remote = createDB({ directory: remoteDirectory, nodeId: 'node-a' })
        const database = (await remote.send({ method: 'database.create', database: 'cold-read' })).database[0]
        const array = (await remote.send({ method: 'array.create', database: 'cold-read', array: 'users' })).array[0]
        const created = await remote.send({
            method: 'object.create', database: 'cold-read', array: 'users',
            object: { name: 'Ada', profile: { city: 'Panama' }, private: { token: 'full-value' } }
        })
        const object = created.object[0]

        await withIndex(async (_localIndex, localDirectory) => {
            const local = createDB({
                directory: localDirectory,
                nodeId: 'node-b',
                peerReader: async ({ nodeId, ...entity }) =>
                    nodeId === 'node-a' ? remote.readLocalEntity(entity) : undefined
            })
            for (const entity of [
                { databaseId: database._id },
                { databaseId: database._id, arrayId: array._id },
                { databaseId: database._id, arrayId: array._id, objectId: object._id }
            ]) {
                await local.updateDistribution({ ...entity, nodeId: 'node-a', operation: 'add' })
            }

            const result = await local.send({
                method: 'object.read',
                database: 'cold-read',
                array: 'users',
                object: { _id: object._id },
                filter: { key: { name: 1, 'profile.city': 1 } }
            })
            assert.equal(result.object[0].name, 'Ada')
            assert.equal(result.object[0].private, undefined)

            const cached = await local.readLocalEntity({
                type: 'object', databaseId: database._id, arrayId: array._id, objectId: object._id
            })
            assert.deepEqual(cached.private, { token: 'full-value' })
            assert.deepEqual(await local.getDistribution({
                databaseId: database._id, arrayId: array._id, objectId: object._id
            }), ['node-a', 'node-b'])
        })
    })
})

test('array and database deletion preserve peer availability references', async () => {
    await withIndex(async (_index, directory) => {
        const db = createDB({ directory, nodeId: 'local-node' })
        const createdDatabase = await db.send({ method: 'database.create', database: 'retained' })
        const databaseId = createdDatabase.database[0]._id
        const createdArray = await db.send({ method: 'array.create', database: 'retained', array: 'first' })
        const arrayId = createdArray.array[0]._id
        const createdObject = await db.send({
            method: 'object.create', database: 'retained', array: 'first', object: { value: 1 }
        })
        const objectId = createdObject.object[0]._id

        for (const entity of [
            { databaseId },
            { databaseId, arrayId },
            { databaseId, arrayId, objectId }
        ]) await db.updateDistribution({ ...entity, nodeId: 'peer-node', operation: 'add' })

        const deletedArray = await db.send({ method: 'array.delete', database: 'retained', array: 'first' })
        assert.equal(deletedArray.success, true, deletedArray.error)
        assert.deepEqual(await db.getDistribution({ databaseId, arrayId }), ['peer-node'])
        assert.deepEqual(await db.getDistribution({ databaseId, arrayId, objectId }), ['peer-node'])

        const createdSecondArray = await db.send({ method: 'array.create', database: 'retained', array: 'second' })
        const secondArrayId = createdSecondArray.array[0]._id
        const secondObject = await db.send({
            method: 'object.create', database: 'retained', array: 'second', object: { value: 2 }
        })
        const secondObjectId = secondObject.object[0]._id
        await db.updateDistribution({ databaseId, arrayId: secondArrayId, nodeId: 'peer-node', operation: 'add' })
        await db.updateDistribution({ databaseId, arrayId: secondArrayId, objectId: secondObjectId, nodeId: 'peer-node', operation: 'add' })

        const deletedDatabase = await db.send({ method: 'database.delete', database: 'retained' })
        assert.equal(deletedDatabase.success, true, deletedDatabase.error)
        assert.deepEqual(await db.getDistribution({ databaseId }), ['peer-node'])
        assert.deepEqual(await db.getDistribution({ databaseId, arrayId: secondArrayId }), ['peer-node'])
        assert.deepEqual(await db.getDistribution({ databaseId, arrayId: secondArrayId, objectId: secondObjectId }), ['peer-node'])
        assert.deepEqual(JSON.parse(await readFile(join(directory, 'databases', databaseId, 'arrays', 'distribution', 'index.json'), 'utf8')).entries.length > 0, true)
    })
})

test('Distribution Index reuses recursive partitions and serializes concurrent updates', async () => {
    await withIndex(async (_index, directory) => {
        const distribution = createDistributionIndex({ directory, maxBytes: 1024 })
        const databaseIds = Array.from({ length: 80 }, (_, index) => String(index + 1).padStart(24, '0'))

        await Promise.all(databaseIds.map(databaseId => distribution.update({
            databaseId,
            nodeId: 'server-local',
            operation: 'add'
        })))

        const references = await distribution.get({ databaseId: databaseIds[40] })
        assert.deepEqual(references, ['server-local'])

        const directoryPath = join(directory, 'databases', 'distribution')
        const files = await readdir(directoryPath)
        const nodes = []
        for (const file of files) {
            if (!file.endsWith('.json')) continue
            const node = JSON.parse(await readFile(join(directoryPath, file), 'utf8'))
            assert.ok(Buffer.byteLength(JSON.stringify(node)) <= 1024)
            nodes.push(node)
        }
        assert.ok(nodes.some(node => Array.isArray(node.indexes)))
        assert.ok(files.includes('index.json'))
    })
})

test('object.delete removes an object and prunes all empty indexes and catalog roots', async () => {
    await withIndex(async (_index, directory) => {
        const db = createDB({ directory })
        const created = await db.send({
            method: 'object.create', database: 'test', array: 'users',
            object: [
                { name: 'Ada', age: 31, unique: 'only-ada' },
                { name: 'Mina', age: 28, unique: 'only-mina' }
            ]
        })
        assert.equal(created.success, true)
        const arrayPath = await resolveArrayDirectory(directory, 'test', 'users')

        const deleted = await db.send({
            method: 'object.delete', database: 'test', array: 'users', object: { _id: created.object[0]._id }
        })
        assert.equal(deleted.success, true, deleted.error)
        assert.equal(deleted.object.length, 1)
        await assert.rejects(readFile(join(arrayPath, 'objects', `${created.object[0]._id}.json`)), { code: 'ENOENT' })

        let { root: catalog, keys } = await readCatalog(directory, 'test', 'users')
        assert.equal(catalog.length, 1)
        assert.ok(keys.unique.string)
        assert.deepEqual((await db.send({
            method: 'object.read', database: 'test', array: 'users', filter: { query: { name: 'Ada' } }
        })).object, [])

        const deletedLast = await db.send({
            method: 'object.delete', database: 'test', array: 'users', filter: { query: { name: 'Mina' } }
        })
        assert.equal(deletedLast.success, true, deletedLast.error)
        assert.equal(deletedLast.object.length, 1)
        ;({ root: catalog, keys } = await readCatalog(directory, 'test', 'users'))
        assert.equal(catalog.length, 0)
        assert.deepEqual(keys, {})
        assert.deepEqual((await readdir(join(arrayPath, 'index'))).sort(), ['index.json'])
        assert.deepEqual(await readdir(join(arrayPath, 'objects')), [])
    })
})
