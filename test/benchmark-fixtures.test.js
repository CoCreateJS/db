import test from 'node:test'
import assert from 'node:assert/strict'
import {
    benchmarkFixtureHash,
    benchmarkRecords,
    benchmarkUuid,
    createBenchmarkRecord,
    createLifecycleFixture,
    lifecycleFixtureHash
} from './fixtures/lifecycle.mjs'

test('standard v3 records are deterministic, representative and do not alter v2 fixtures', () => {
    const original = createLifecycleFixture(1000)
    assert.equal(lifecycleFixtureHash(original), '25ebce8889cb93e29279301a3681ce66ebe80d5cb0d147387455ad5cddb44e48')

    const first = createBenchmarkRecord(17, 1000)
    assert.deepEqual(first, createBenchmarkRecord(17, 1000))
    assert.equal(first.uuid, benchmarkUuid(17))
    assert.equal(typeof first.rank, 'number')
    assert.equal(typeof first.active, 'boolean')
    assert.equal(typeof first.createdAt, 'string')
    assert.ok(Number.isFinite(Date.parse(first.createdAt)))
    assert.ok(Array.isArray(first.tags))
    assert.equal(typeof first.profile.location.region, 'string')
    assert.ok(createBenchmarkRecord(1, 1000).payload.length !== createBenchmarkRecord(2, 1000).payload.length)
    assert.equal([...benchmarkRecords(10)].length, 10)
    assert.equal(benchmarkFixtureHash(1000), benchmarkFixtureHash(1000))
})
