import assert from 'node:assert/strict'
import test from 'node:test'
import { objectToDotNotation, queryData } from '@cocreate/utils'
import { createObject, objectIndexes } from '../src/object/initialize.js'

const uuid = '0123456789abcdef0123456789abcdef'

test('initializes the original object once with hidden live index entries', () => {
    const artifacts = new Map()
    const source = {
        _id: 'document-1',
        price: 20,
        profile: { team: 'blue', score: 0 },
        rows: [{ enabled: false }, { enabled: true }],
        empty: {},
        list: []
    }
    const object = createObject(source, { uuid, artifacts })
    const entry = object.getIndex('profile.team')

    assert.strictEqual(object, source)
    assert.strictEqual(artifacts.get(uuid), source)
    assert.strictEqual(entry.object, object)
    assert.equal(entry.key, 'profile.team')
    assert.equal(entry.value, 'blue')
    assert.strictEqual(entry.parent, object.profile)
    assert.equal(entry.property, 'team')
    object.profile.team = 'green'
    assert.equal(entry.value, 'green')
    assert.strictEqual(object.getIndex(), objectIndexes(object))
    assert.equal(object.getValue('profile.score'), 0)
    assert.equal(object.getValue('rows[0].enabled'), false)
    assert.ok(object.getIndex('empty'))
    assert.ok(object.getIndex('list'))
    assert.equal(Object.hasOwn(object, 'getValue'), false)
    assert.equal(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(object), 'getValue').enumerable, false)
    assert.deepEqual(objectToDotNotation(object).profile, undefined)
    assert.equal(queryData(object, { 'profile.team': 'green' }), true)
    assert.equal(JSON.stringify(object).includes('getIndex'), false)

    const restored = createObject({}, { artifacts })
    assert.match(restored.uuid, /^[a-f0-9]{32}$/)
})

test('preserves data properties that shadow shared object methods', () => {
    const object = createObject({ uuid, getValue: 'application data', getIndex: 7, value: 1 })
    const prototype = Object.getPrototypeOf(object)

    assert.equal(object.getValue, 'application data')
    assert.equal(object.getIndex, 7)
    assert.equal(prototype.getValue.call(object, 'value'), 1)
    assert.equal(prototype.getIndex.call(object, 'value').value, 1)
    assert.equal(JSON.parse(JSON.stringify(object)).getValue, 'application data')
})
