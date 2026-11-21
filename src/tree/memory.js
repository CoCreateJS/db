import { totalmem } from 'node:os'

const stages = [
    { pressure: .05, artifacts: 0 },
    { pressure: .10, artifacts: 0 },
    { pressure: .20, artifacts: 0 },
    { pressure: .40, artifacts: 0 },
    { pressure: .60, artifacts: 0 },
    { pressure: .80, artifacts: 64 },
    { pressure: .90, artifacts: 128 },
    { pressure: 1,   artifacts: 512 }
]
const sampleLimit = 128

// RSS is a primary-process proxy, not an exact database allocation measurement.
export class MemoryPolicy {
    constructor(local, { memory = 25, systemMemory = totalmem(), interval = 100, hysteresis = .025 } = {}, artifacts) {
        this.budget = systemMemory * memory / 100
        this.interval = interval
        this.hysteresis = hysteresis
        this.stage = 0
        this.checked = -Infinity
        this.samples = []
        this.artifactSamples = []
        this.index = { samples: this.samples, evict: () => local.evictLowestWeight() }
        this.payload = artifacts && {
            samples: this.artifactSamples,
            evict: stage => artifacts.evictBatch(stage.artifacts)
        }
    }
    check(now = performance.now(), rss) {
        if (this.error) return
        rss ??= process.memoryUsage.rss()
        const pressure = rss / this.budget
        const overBudget = pressure >= 1
        if (!overBudget) {
            this.index.pending = null
            if (this.payload) this.payload.pending = null
            if (now - this.checked < this.interval) return
        }
        this.checked = now

        let stage = this.stage
        while (stage < stages.length && pressure >= stages[stage].pressure) stage++
        while (stage > 0 && pressure < stages[stage - 1].pressure - this.hysteresis) stage--
        this.stage = stage
        if (!stage) return

        const sample = { rss, stage }
        this.signal(this.index, sample, overBudget)
        if (this.payload && stages[stage - 1].artifacts) this.signal(this.payload, sample, overBudget)
    }
    signal(tier, sample, overBudget) {
        if (!tier.job) tier.job = Promise.resolve().then(() => this.prune(tier, sample))
        else if (overBudget) tier.pending = sample
    }
    async prune(tier, sample) {
        try {
            while (sample && !this.error) {
                const { rss, stage } = sample
                const started = performance.now()
                const options = stages[stage - 1]
                const result = await tier.evict(options)
                tier.samples.push({ rss, stage, threshold: options.pressure, ...result,
                    elapsedMs: performance.now() - started, afterRss: process.memoryUsage.rss() })
                if (tier.samples.length > sampleLimit) tier.samples.shift()
                sample = tier.pending
                tier.pending = null
            }
        } catch (error) {
            this.error = error
        } finally {
            tier.job = null
            tier.pending = null
        }
    }
    async flush() {
        await Promise.all([this.index.job, this.payload?.job])
        if (this.error) throw this.error
    }
}
