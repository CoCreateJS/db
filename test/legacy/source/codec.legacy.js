import assert from 'node:assert/strict'
import test from 'node:test'
import { parseValue, stringifyValue } from '../src/codec.js'

test('database JSON codec preserves undefined values, array slots, and tag-like user objects', () => {
    const value = { explicit: undefined, array: ['a', undefined, null, { nested: undefined }] }
    value.sparse = Array(2)
    value.sparse[1] = 'tail'
    value['\0cocreate.db.value'] = 'ordinary user data'

    const restored = parseValue(stringifyValue(value))
    assert.equal(Object.hasOwn(restored, 'explicit'), true)
    assert.equal(restored.explicit, undefined)
    assert.deepEqual(restored.array, ['a', undefined, null, { nested: undefined }])
    assert.equal(Object.hasOwn(restored.sparse, 0), true)
    assert.equal(restored.sparse[0], undefined)
    assert.equal(restored.sparse[1], 'tail')
    assert.equal(restored['\0cocreate.db.value'], 'ordinary user data')
})
