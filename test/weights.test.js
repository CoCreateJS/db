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

test('bounded eviction starts with the lowest weights and caps concurrency', async () => {
    const weights = new Weights()
    for (const viewed of [5, 4, 1, 2, 0, 1]) weights.add({viewed})
    const started = []
    let running = 0, mostRunning = 0
    const result = await weights.evictBatch(4, () => true, async object => {
        started.push(object.viewed)
        mostRunning = Math.max(mostRunning, ++running)
        await new Promise(setImmediate)
        running--
        weights.remove(object)
        return true
    }, {maxWeight: 2, concurrency: 2})
    assert.deepEqual(started, [0, 1, 1, 2])
    assert.equal(mostRunning, 2)
    assert.equal(result.count, 4)
    assert.equal(weights.size, 2)
})

test('bounded eviction skips candidates that become hot while another write is active', async () => {
    const weights = new Weights()
    const first = { viewed: 0 }, later = { viewed: 0 }
    weights.add(first)
    weights.add(later)
    const result = await weights.evictBatch(2, () => true, async object => {
        assert.equal(object, first)
        weights.touch(later)
        weights.remove(object)
        return true
    }, {concurrency: 1})
    assert.equal(result.count, 1)
    assert.equal(result.skipped, 1)
})

test('eviction selects all 300 partitions in the first eligible weight group, even above 16 views', async () => {
    const weights = new Weights()
    const branch = {viewed: 0, leaf: false}
    const higher = {viewed: 51, leaf: true}
    weights.add(branch)
    for (let i = 0; i < 300; i++) weights.add({viewed: 50, leaf: true})
    weights.add(higher)

    let active = 0, peak = 0
    const result = await weights.evictLowestWeight(partition => partition.leaf, async partition => {
        assert.equal(partition.viewed, 50)
        peak = Math.max(peak, ++active)
        await new Promise(setImmediate)
        active--
        weights.remove(partition)
        return true
    })
    assert.deepEqual(result, {weight: 50, target: 300, candidates: 300, count: 300, skipped: 0})
    assert.equal(peak, 4)
    assert.equal(weights.size, 2)
    assert.equal(weights.has(branch), true)
    assert.equal(weights.has(higher), true)

    const next = await weights.evictLowestWeight(partition => partition.leaf, async partition => weights.remove(partition))
    assert.equal(next.weight, 51)
    assert.equal(next.count, 1)
})

test('whole-group eviction skips an item touched after selection', async () => {
    const weights = new Weights()
    const first = {viewed: 2}, touched = {viewed: 2}
    weights.add(first)
    weights.add(touched)
    const result = await weights.evictLowestWeight(() => true, async partition => {
        assert.equal(partition, first)
        weights.touch(touched)
        return weights.remove(partition)
    }, {concurrency: 1})
    assert.equal(result.count, 1)
    assert.equal(result.skipped, 1)
    assert.equal(weights.has(touched), true)
    assert.equal(touched.viewed, 3)
})
