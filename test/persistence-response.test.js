import assert from 'node:assert/strict'
import test from 'node:test'
import { readPersistenceResponse } from '../src/persistence/response.js'

test('persistence parses individual JSON file values and observes UTF-8 bytes', () => {
    const raw = ' { "name": "Lima 🌎", "$bytes": 1 } '
    const response = { persistence: [{ path: 'objects/file.json', value: raw }] }
    assert.strictEqual(readPersistenceResponse(response, {}), response)
    assert.deepEqual(response.persistence[0].value, { name: 'Lima 🌎', $bytes: Buffer.byteLength(raw) })
    assert.equal('$bytes' in response, false, 'envelope bytes are not a file-size observation')
})

test('parsed persistence values retain their references and are never encoded for measurement', t => {
    const record = { nested: { value: 1 } }, observed = { $bytes: 123 }
    const response = { persistence: Object.freeze([Object.freeze({ value: record }), Object.freeze({ value: observed })]) }
    t.mock.method(JSON, 'stringify', () => assert.fail('No size-only encoding'))
    assert.strictEqual(readPersistenceResponse(response, {}), response)
    assert.strictEqual(response.persistence[0].value, record)
    assert.strictEqual(response.persistence[1].value, observed)
    assert.equal('$bytes' in record, false)
    assert.equal(observed.$bytes, 123)
})

test('serialized envelopes and legacy records are decoded without attributing envelope bytes to records', () => {
    const record = '{"_id":"000000000000000000000001","name":"Ana"}'
    const response = readPersistenceResponse(JSON.stringify({ success: true, object: [record] }), {})
    assert.equal(response.object[0].$bytes, Buffer.byteLength(record))
    assert.equal('$bytes' in response, false)
    const raw = '{"entries":[],"length":0}'
    assert.deepEqual(readPersistenceResponse(raw, {}), { entries: [], length: 0, $bytes: Buffer.byteLength(raw) })
})

for (const envelope of [false, true]) test(`invalid persistence JSON accumulates safe request errors (envelope=${envelope})`, t => {
    const errors = ['earlier failure'], data = { error: errors }
    t.mock.method(console, 'error', () => assert.fail('Persistence errors belong on data.error'))
    const raw = '{"key":"credential-fragment"'
    assert.strictEqual(readPersistenceResponse(envelope ? raw : { persistence: [{ value: raw }] }, data), data)
    assert.strictEqual(data.error, errors)
    assert.deepEqual(errors, ['earlier failure', 'Persistence returned invalid JSON.'])
    assert.equal(data.success, false)
})
