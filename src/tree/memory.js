import { totalmem } from 'node:os'

const indexFractions = [0, .05, .10, .15, .25, .50]
const artifactFractions = [0, 0, 0, 0, .05, .25]
const sampleLimit = 128

// RSS is a primary-process proxy, not an exact database allocation measurement.
export class MemoryPolicy {
    constructor(local, { memory = 25, systemMemory = totalmem(), interval = 1000 } = {}, artifacts) {
        this.local = local
        this.artifacts = artifacts
        this.budget = systemMemory * memory / 100
        this.interval = interval
        this.checked = -Infinity
        this.samples = []
        this.job = null
    }
    check(now = performance.now()) {
        if (this.job || now - this.checked < this.interval) return
        this.checked = now
        const rss = process.memoryUsage.rss()
        const stage = Math.min(5, Math.floor(rss / this.budget * 5))
        if (!stage) return
        // A single nonoverlapping pass; the next check may schedule another pass.
        this.job = this.evict(rss, stage)
            .catch(error => { this.error = error })
            .finally(() => { this.job = null })
    }
    async evict(rss, stage) {
        const result = await this.local.evictAsync(Infinity, indexFractions[stage])
        const fraction = artifactFractions[stage]
        const artifacts = fraction ? await this.artifacts?.evict(fraction) : undefined
        this.samples.push({ rss, stage, ...result, artifacts, afterRss: process.memoryUsage.rss() })
        if (this.samples.length > sampleLimit) this.samples.shift()
    }
    async flush() {
        await this.job
        if (this.error) throw this.error
    }
}
