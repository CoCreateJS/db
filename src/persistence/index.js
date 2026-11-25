const hasError = response => response?.error || response?.data?.error || response?.success === false

/** In-memory external-persistence journal; dispatch is controlled by persist(). */
export class Persistence {
    constructor({ pending = Object.create(null), get = async () => undefined, send } = {}) {
        this.pending = pending
        this.get = get
        this.send = send
        this.running = Promise.resolve()
    }

    /** Read one UUID from the configured persistence provider on a local miss. */
    async read(uuid) {
        if (typeof uuid !== 'string' || !uuid) return undefined
        if (typeof this.send !== 'function') return undefined
        const response = await this.send({ method: 'persistence.read', persistence: { uuid } })
        if (response == null) return undefined
        if (hasError(response)) throw response?.error ?? response?.data?.error ?? new Error('Persistence read failed')
        const value = response.persistence ?? response.data?.persistence ?? response.data ?? (typeof response.uuid === 'string' ? response : undefined)
        if (value === undefined || value === null) return undefined
        if (typeof value !== 'object' || Array.isArray(value) || value.uuid !== uuid)
            throw new Error(`Persistence returned an invalid leaf for UUID ${uuid}`)
        return value
    }

    async stage(envelope) {
        if (envelope?.method !== 'persistence.stage') throw new Error(`Unsupported persistence hook: ${envelope?.method}`)
        const { root, uuid, op } = envelope.persistence ?? {}
        if (typeof root !== 'string' || typeof uuid !== 'string' || !['upsert', 'delete'].includes(op))
            throw new TypeError('Persistence stage requires root, uuid, and an upsert or delete operation')
        const group = this.pending[root] ??= Object.create(null)
        group[uuid] = { op }
        return { success: true }
    }

    persist() {
        if (typeof this.send !== 'function') return Promise.resolve({ success: false, skipped: true })
        this.running = this.running.then(() => this.flush(), () => this.flush())
        return this.running
    }

    async flush() {
        const results = []
        for (const [root, group] of Object.entries(this.pending)) {
            for (const [uuid, entry] of Object.entries(group)) {
                try {
                    const value = entry.op === 'delete' ? undefined : await this.get(uuid)
                    if (entry.op !== 'delete' && !value) throw new Error(`Pending persistence leaf is unavailable: ${uuid}`)
                    const envelope = entry.op === 'delete'
                        ? { method: 'persistence.delete', persistence: { uuid } }
                        : { method: 'persistence.upsert', persistence: structuredClone(Object.fromEntries(Object.entries(value))) }
                    const response = await this.send(envelope)
                    if (response == null || hasError(response)) throw response?.error ?? response?.data?.error ?? new Error('Persistence request failed')
                    if (this.pending[root]?.[uuid] === entry) {
                        delete this.pending[root][uuid]
                        if (!Object.keys(this.pending[root]).length) delete this.pending[root]
                    }
                    results.push({ root, uuid, success: true, response })
                } catch (error) {
                    if (this.pending[root]?.[uuid] === entry) entry.error = error?.message ?? String(error)
                    results.push({ root, uuid, success: false, error })
                }
            }
        }
        return { success: results.every(result => result.success), results }
    }
}

export default Persistence
