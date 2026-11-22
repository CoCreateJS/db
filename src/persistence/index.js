const present = error => Array.isArray(error) ? error.length > 0 : error != null && error !== false && error !== ''
const hasError = response => present(response?.error) || present(response?.data?.error) || response?.success === false

const responseError = response => {
    const error = response?.data?.error ?? response?.error
    return error instanceof Error ? error : new Error(Array.isArray(error) ? error.join('; ') : String(error ?? 'Persistence request failed'))
}

/** External persistence transport and the in-memory pending journal runner. */
export class Persistence {
    constructor({ pending, get, remove } = {}) {
        this.pending = pending ?? Object.create(null)
        this.get = get ?? (() => undefined)
        this.remove = remove ?? (() => {})
        this.transport = undefined
        this.running = Promise.resolve()
    }

    register(send) {
        if (typeof send !== 'function') throw new TypeError('Persistence transport must be a function')
        this.transport = send
        return () => {
            if (this.transport === send) this.transport = undefined
        }
    }

    send(envelope) {
        if (!this.transport) return undefined
        return this.transport(envelope)
    }

    persist() {
        if (!this.transport) return Promise.resolve({ success: false, skipped: true })
        this.running = this.running.then(() => this.flush(), () => this.flush())
        return this.running
    }

    async flush() {
        const results = []
        for (const [root, group] of Object.entries(this.pending)) {
            for (const [uuid, entry] of Object.entries(group)) {
                // A local mutation can replace this journal entry while send is in flight.
                const operation = entry.op
                try {
                    let envelope
                    if (operation === 'delete') {
                        envelope = { method: 'persistence.delete', persistence: { uuid } }
                    } else {
                        const value = this.get(uuid)
                        if (!value) throw new Error(`Pending persistence leaf is unavailable: ${uuid}`)
                        envelope = { method: 'persistence.upsert', persistence: structuredClone(Object.fromEntries(Object.entries(value))) }
                    }
                    const response = await this.send(envelope)
                    if (response == null) throw new Error('Persistence provider returned no acknowledgement')
                    if (hasError(response)) throw responseError(response)
                    if (this.pending[root]?.[uuid] === entry) this.remove(root, uuid, entry)
                    results.push({ root, uuid, success: true, response })
                } catch (error) {
                    if (this.pending[root]?.[uuid] === entry && typeof entry === 'object') entry.error = error.message
                    results.push({ root, uuid, success: false, error })
                }
            }
        }
        return { success: results.every(result => result.success), results }
    }
}

export default Persistence
