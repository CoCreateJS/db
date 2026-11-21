import { readFileSync } from 'node:fs'
import { freemem, totalmem } from 'node:os'

const stages = [
    .10, .20, .30, .40, .50, .60, .80, .90
]
const diskFirstPressure = .90
const sampleLimit = 128
const getAvailableMemory = () => {
    try {
        const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(readFileSync('/proc/meminfo', 'utf8'))
        if (match) return Number(match[1]) * 1024
    } catch {}
    return freemem()
}

// RSS is a primary-process proxy, not an exact database allocation measurement.
export class MemoryPolicy {
    constructor(local, { memory = 25, systemMemory = totalmem(), availableMemory: available = getAvailableMemory(), interval = 100, hysteresis = .025 } = {}, leaves) {
        this.totalMemory = systemMemory
        this.availableMemory = available
        this.requestedBudget = systemMemory * memory / 100
        this.budget = Math.min(this.requestedBudget, available)
        this.interval = interval
        this.hysteresis = hysteresis
        this.stage = 0
        this.diskFirst = false
        this.checked = -Infinity
        this.samples = []
        this.leafSamples = []
        this.index = { samples: this.samples, evict: () => local.evictLowestWeight() }
        this.payload = leaves && {
            samples: this.leafSamples,
            evict: () => leaves.evictLowestWeight()
        }
    }
    check(now = performance.now(), rss) {
        if (this.error) return
        rss ??= process.memoryUsage.rss()
        const pressure = rss / this.budget
        const urgentPressure = pressure >= diskFirstPressure
        this.diskFirst = this.diskFirst
            ? pressure >= diskFirstPressure - this.hysteresis
            : pressure >= diskFirstPressure
        if (!urgentPressure) {
            this.index.pending = null
            if (this.payload) this.payload.pending = null
            if (now - this.checked < this.interval) return
        }
        this.checked = now

        let stage = this.stage
        while (stage < stages.length && pressure >= stages[stage]) stage++
        while (stage > 0 && pressure < stages[stage - 1] - this.hysteresis) stage--
        this.stage = stage
        if (!stage) return

        const sample = { rss, stage }
        this.signal(this.index, sample, urgentPressure)
        if (this.payload) this.signal(this.payload, sample, urgentPressure)
    }
    signal(tier, sample, urgentPressure) {
        if (!tier.job) tier.job = Promise.resolve().then(() => this.prune(tier, sample))
        else if (urgentPressure) tier.pending = sample
    }
    async prune(tier, sample) {
        try {
            while (sample && !this.error) {
                const { rss, stage } = sample
                const started = performance.now()
                const threshold = stages[stage - 1]
                const result = await tier.evict()
                tier.samples.push({ rss, stage, threshold,
                    ...result,
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
