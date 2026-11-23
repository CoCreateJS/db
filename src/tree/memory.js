const stages = [
    .10, .20, .30, .40, .50, .60, .80, .90
]
const diskFirstPressure = .90
const sampleLimit = 128

export class MemoryPolicy {
    constructor(local, { memory = 25, systemMemory, availableMemory, interval = 100, hysteresis = .025 } = {}, leaves) {
        this.memory = memory
        this.totalMemory = systemMemory
        this.availableMemory = availableMemory ?? systemMemory
        this.requestedBudget = Number.isFinite(systemMemory) ? systemMemory * memory / 100 : undefined
        this.budget = this.requestedBudget === undefined ? undefined : Math.min(this.requestedBudget, this.availableMemory)
        this.baselineUsedMemory = undefined
        this.baselineReady = false
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
    update(sample, now = performance.now()) {
        const total = Number(sample?.memory?.total)
        const maximum = Number(sample?.memory?.max)
        if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(maximum) || maximum < 0 || maximum > 100) return false

        const usedMemory = total * maximum / 100
        if (!this.baselineReady) {
            this.totalMemory = total
            this.baselineUsedMemory = usedMemory
            this.availableMemory = Math.max(0, total - usedMemory)
            this.requestedBudget = total * this.memory / 100
            this.budget = Math.min(this.requestedBudget, this.availableMemory)
            this.baselineReady = true
            if (this.budget === 0) this.checkPressure(now, 0, 1)
            return true
        }

        const addedMemory = Math.max(0, usedMemory - this.baselineUsedMemory)
        const pressure = this.budget > 0 ? addedMemory / this.budget : 1
        this.checkPressure(now, addedMemory, pressure)
        return true
    }
    check(now = performance.now(), usedMemory) {
        if (!Number.isFinite(usedMemory) || !Number.isFinite(this.budget) || this.budget <= 0) return
        this.checkPressure(now, usedMemory, usedMemory / this.budget)
    }
    checkPressure(now, usedMemory, pressure) {
        if (this.error) return
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

        const sample = { usedMemory, pressure, stage }
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
                const { usedMemory, pressure, stage } = sample
                const started = performance.now()
                const threshold = stages[stage - 1]
                const result = await tier.evict()
                tier.samples.push({ usedMemory, pressure, stage, threshold,
                    ...result,
                    elapsedMs: performance.now() - started })
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
