// Ordered nonempty frequency buckets. A touch moves only one bucket forward.
export class Weights {
    constructor() {
        this.buckets = new Map()
        this.first = null
        this.size = 0
    }
    insert(weight, previous = null) {
        const next = previous ? previous.next : this.first
        const bucket = {weight, values: new Set(), previous, next}
        if (previous) previous.next = bucket
        else this.first = bucket
        if (next) next.previous = bucket
        this.buckets.set(weight, bucket)
        return bucket
    }
    add(object) {
        let bucket = this.buckets.get(object.viewed)
        if (!bucket) {
            let previous = null
            for (let node = this.first; node && node.weight < object.viewed; node = node.next) previous = node
            bucket = this.insert(object.viewed, previous)
        }
        if (!bucket.values.has(object)) {
            bucket.values.add(object)
            this.size++
        }
    }
    remove(object) {
        const bucket = this.buckets.get(object.viewed)
        if (!bucket?.values.delete(object)) return false
        this.size--
        if (!bucket.values.size) {
            if (bucket.previous) bucket.previous.next = bucket.next
            else this.first = bucket.next
            if (bucket.next) bucket.next.previous = bucket.previous
            this.buckets.delete(bucket.weight)
        }
        return true
    }
    touch(object) {
        const bucket = this.buckets.get(object.viewed)
        if (!bucket?.values.has(object)) {
            object.viewed++
            this.add(object)
            return
        }
        const next = this.buckets.get(object.viewed + 1) ?? this.insert(object.viewed + 1, bucket)
        this.remove(object)
        object.viewed++
        next.values.add(object)
        this.size++
    }
    get(weight) { return this.buckets.get(weight)?.values }
    has(object) { return this.get(object.viewed)?.has(object) ?? false }
    *keys() { for (const [weight] of this) yield weight }
    *[Symbol.iterator]() {
        for (let node = this.first; node; node = node.next) yield [node.weight, node.values]
    }
    async evictBatch(limit, eligible, evict, { maxWeight = Infinity, concurrency = 4 } = {}) {
        const selected = []
        if (limit <= 0) return {target: limit, candidates: 0, count: 0, skipped: 0}
        select: for (const [weight, values] of this) {
            if (weight > maxWeight) break
            for (const object of values) {
                if (eligible(object)) selected.push({object, weight})
                if (selected.length === limit) break select
            }
        }

        return {target: limit, candidates: selected.length, ...await this.evictSelected(selected, eligible, evict, concurrency)}
    }

    async evictLowestWeight(eligible, evict, { concurrency = 4 } = {}) {
        for (const [weight, values] of this) {
            // Snapshot the whole group. Writes can run in parallel, but they
            // never expand the group to include a higher weight.
            const selected = []
            for (const object of values) if (eligible(object)) selected.push({object, weight})
            if (selected.length) {
                return {weight, target: selected.length, candidates: selected.length,
                    ...await this.evictSelected(selected, eligible, evict, concurrency)}
            }
        }
        return {weight: null, target: 0, candidates: 0, count: 0, skipped: 0}
    }

    async evictSelected(selected, eligible, evict, concurrency) {
        let next = 0, count = 0, skipped = 0
        const worker = async () => {
            while (next < selected.length) {
                const {object, weight} = selected[next++]
                if (object.viewed === weight && this.has(object) && eligible(object) && await evict(object)) count++
                else skipped++
            }
        }
        // Wait for all workers to settle before another batch can start, including on error.
        const results = await Promise.allSettled(Array.from({length: Math.min(concurrency, selected.length)}, worker))
        for (const result of results) if (result.status === 'rejected') throw result.reason
        return {count, skipped}
    }

    // Snapshot only the requested lowest ranks, not the entire eligible population.
    // Never hold a live bucket iterator across an asynchronous disk write.
    async evict(fraction, eligible, evict, maxWeight = Infinity) {
        let candidates = 0
        for (const [weight, values] of this) {
            if (weight > maxWeight) break
            for (const object of values) if (eligible(object)) candidates++
        }
        const target = Math.ceil(candidates * fraction)
        const selected = []
        for (const [weight, values] of this) {
            if (weight > maxWeight || selected.length >= target) break
            for (const object of values) {
                if (selected.length >= target) break
                if (eligible(object)) selected.push({object, weight})
            }
        }
        let count = 0, skipped = 0
        for (const {object, weight} of selected) {
            if (object.viewed === weight && this.has(object) && eligible(object) && await evict(object)) count++
            else skipped++
            await nextTurn()
        }
        return {candidates, target, count, skipped}
    }
}
import { nextTurn } from '../defer.js'
