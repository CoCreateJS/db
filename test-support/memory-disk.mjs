export const leafPath = uuid => `leaves/${Buffer.from(uuid).toString('hex')}.json`

export class MemoryDisk {
    constructor(config) {
        this.files = new Map()
        this.events = []
        if (config !== undefined) this.files.set('config.json', JSON.stringify(config))
    }

    async execute({ operation, kind, path, data }) {
        if (operation === 'clear') {
            this.files.clear()
            return true
        }

        if (operation === 'list') {
            const prefix = path ? `${path}/` : ''
            return [...this.files.keys()]
                .filter(file => file.startsWith(prefix) && !file.slice(prefix.length).includes('/'))
                .map(file => file.slice(prefix.length))
        }

        if (kind !== 'file') throw new Error(`Unexpected memory disk kind: ${kind}`)
        const resource = path === 'config.json' ? 'config' : path.startsWith('branches/') ? 'branch' : 'leaf'
        const action = `${resource}-${operation}`
        this.events.push(action)

        if (operation === 'read') {
            if (!this.files.has(path)) {
                const error = new Error(`Missing memory disk file: ${path}`)
                error.code = 'ENOENT'
                throw error
            }
            return this.files.get(path)
        }
        if (operation === 'write') {
            this.files.set(path, data)
            return true
        }
        if (operation === 'delete') {
            this.files.delete(path)
            return true
        }
        if (operation === 'has') return this.files.has(path)
        throw new Error(`Unsupported memory disk operation: ${operation}`)
    }

    hasLeaf(uuid) { return this.files.has(leafPath(uuid)) }
    readLeaf(uuid) { return this.files.get(leafPath(uuid)) }
}
