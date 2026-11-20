import test from 'node:test'
import assert from 'node:assert/strict'
import { Weights } from '../src/tree/weights.js'

test('weight buckets stay ordered through touches, removals and re-additions', () => {
    const weights = new Weights()
    const [a, b, c, d] = [10, 4, 4, 8].map(viewed => ({ viewed }))
    for (const object of [a, b, c, d]) weights.add(object)

    assert.deepEqual([...weights.keys()], [4, 8, 10])
    weights.touch(b)
    weights.touch(c)
    assert.deepEqual([...weights.keys()], [5, 8, 10])
    assert.equal(weights.size, 4)

    weights.remove(b)
    weights.remove(c)
    assert.deepEqual([...weights.keys()], [8, 10])
    weights.add(c)
    assert.deepEqual([...weights.keys()], [5, 8, 10])
    assert.equal(weights.size, 3)
})

test('eviction chooses the lowest eligible weights', async () => {
    const weights = new Weights()
    const objects = [10, 4, 8, 5].map(viewed => ({ viewed }))
    for (const object of objects) weights.add(object)
    const removed = []

    const result = await weights.evict(.5, object => object.viewed !== 4, object => {
        removed.push(object.viewed)
        return weights.remove(object)
    })

    assert.deepEqual(removed, [5, 8])
    assert.deepEqual(result, { candidates: 3, target: 2, count: 2, skipped: 0 })
})

test('eviction skips a candidate touched during an asynchronous pass', async () => {
    const weights = new Weights()
    const first = { viewed: 4 }
    const second = { viewed: 5 }
    weights.add(first)
    weights.add(second)

    const result = await weights.evict(1, () => true, async object => {
        weights.touch(second)
        return weights.remove(object)
    })

    assert.deepEqual(result, { candidates: 2, target: 2, count: 1, skipped: 1 })
    assert.equal(weights.has(second), true)
    assert.equal(second.viewed, 6)
})
