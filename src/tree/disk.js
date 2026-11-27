import { defer, cancelDefer } from './defer.js'

const entries = () => Object.create(null)
const group = () => ({ leaves: entries(), branches: entries() })

let writing = 0
const waiting = []
async function writeFile(write, operation) {
    if (writing === 16) await new Promise(resolve => waiting.push(resolve))
    else writing++
    try { return await write(operation) }
    finally {
        const next = waiting.shift()
        if (next) next()
        else writing--
    }
}

/** Completed index work handed to storage. File bytes never reference live nodes. */
export class DiskQueue {
    constructor(uuid, write, persist, onStored, onIdle) {
        Object.assign(this, { uuid, write, persist, onStored, onIdle })
    }

    pendingCount = 0
    inFlightCount = 0
    get size() { return this.pendingCount + this.inFlightCount }
    hasLeaf(uuid) { return !!(this.pending?.leaves[uuid] || this.inFlight?.leaves[uuid]) }
    toJSON() {
        return { [this.uuid]: {
            leaves: { ...this.inFlight?.leaves, ...this.pending?.leaves },
            branches: { ...this.inFlight?.branches, ...this.pending?.branches },
            config: this.pending?.config ?? this.inFlight?.config
        } }
    }

    enqueue({ leaves, branches, config }) {
        const pending = this.pending ??= group()
        for (const [kind, changes] of [['leaves', leaves], ['branches', branches]]) for (const uuid in changes) {
            if (!Object.hasOwn(pending[kind], uuid)) this.pendingCount++
            pending[kind][uuid] = changes[uuid]
        }
        if (config !== undefined) {
            if (!pending.config) this.pendingCount++
            pending.config = { operation: 'write', data: config }
        }
        this.schedule()
    }

    schedule() {
        if (this.closed || !this.pending || this.running || this.scheduled || this.error) return
        this.scheduled = defer(() => {
            this.scheduled = undefined
            this.running = this.drain().catch(error => { this.error = error }).finally(() => {
                this.running = undefined
                this.schedule()
                this.onIdle()
            })
        })
    }

    async each(records, visit) {
        const items = Object.entries(records)
        let next = 0, error
        await Promise.all(Array.from({ length: Math.min(16, items.length) }, async () => {
            while (next < items.length && !error) {
                const [uuid, record] = items[next++]
                try { await visit(uuid, record) } catch (failure) { error ??= failure }
            }
        }))
        if (error) throw error
    }

    async files(kind, records, operation) {
        await this.each(records, async (uuid, record) => {
            if (record.operation === operation) await writeFile(this.write, { operation: record.operation, data: record.data, kind, uuid })
        })
    }

    async drain() {
        const batch = this.inFlight = this.pending
        this.pending = undefined
        this.inFlightCount = this.pendingCount
        this.pendingCount = 0
        await this.files('leaf', batch.leaves, 'write')
        await this.files('branch', batch.branches, 'write')
        if (batch.config) await writeFile(this.write, { ...batch.config, kind: 'config', uuid: this.uuid })
        await this.files('branch', batch.branches, 'delete')
        await this.files('leaf', batch.leaves, 'delete')
        await this.each(batch.branches, (uuid, record) => this.persist({ operation: record.operation, kind: 'branch', uuid }))
        await this.each(batch.leaves, (uuid, record) => record.notify === false ? undefined : this.persist({ operation: record.operation, kind: 'leaf', uuid }))
        if (batch.config) await this.persist({ ...batch.config, kind: 'config', uuid: this.uuid })
        this.inFlight = undefined
        this.inFlightCount = 0
        this.onStored(batch)
    }

    async close() {
        this.closed = true
        if (this.scheduled) cancelDefer(this.scheduled)
        this.scheduled = undefined
        await this.running
        if (this.error) throw this.error
        while (this.pending) await this.drain()
    }
}
