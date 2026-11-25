const operations = new Set(['initialize', 'read', 'write', 'delete', 'has', 'list'])

/** Send one asynchronous disk envelope and unwrap its data result. */
export async function requestDisk(disk, method, details = {}) {
    if (typeof disk !== 'function') throw new TypeError('Tree requires a disk callback for this operation')
    const response = await disk({ method, disk: details })
    if (response == null) throw new Error(`Disk handler returned no response for ${method}`)
    if (response.error || response.success === false) {
        const error = response.error instanceof Error
            ? response.error
            : new Error(Array.isArray(response.error) ? response.error.join('; ') : String(response.error ?? `Disk request failed: ${method}`))
        throw error
    }
    return Object.hasOwn(response, 'data') ? response.data : response
}

/**
 * Adapt a storage provider to Tree's single
 * envelope-based disk callback. Platform selection stays outside Tree.
 */
export function createStorageDisk(storage) {
    if (!storage) throw new TypeError('createStorageDisk requires a storage provider')
    return async envelope => {
        const method = envelope?.method
        const request = envelope?.disk ?? {}
        const { kind, uuid, data } = request
        if (method === 'disk.initialize') {
            await storage.initialize()
            return { success: true }
        }
        if (!operations.has(method?.slice(5))) throw new Error(`Unsupported disk method: ${method}`)
        if (!['config', 'branch', 'leaf'].includes(kind)) throw new Error(`Unsupported disk kind: ${kind}`)
        let result
        switch (method) {
            case 'disk.read':
                result = kind === 'config' ? await storage.readConfig() : kind === 'branch' ? await storage.readBranch(uuid) : await storage.readLeaf(uuid)
                return { success: true, data: result }
            case 'disk.write':
                if (kind === 'config') await storage.writeConfig(data)
                else if (kind === 'branch') await storage.writeBranch(uuid, data)
                else await storage.writeLeaf(uuid, data)
                return { success: true }
            case 'disk.delete':
                if (kind === 'config') throw new Error('Deleting disk config is unsupported')
                if (kind === 'branch') await storage.deleteBranch(uuid)
                else await storage.deleteLeaf(uuid)
                return { success: true }
            case 'disk.has':
                result = kind === 'config' ? true : kind === 'branch' ? await storage.hasBranch(uuid) : await storage.hasLeaf(uuid)
                return { success: true, data: result }
            case 'disk.list':
                if (kind === 'config') throw new Error('Listing disk config is unsupported')
                result = kind === 'branch' ? await storage.listBranches() : await storage.listLeaves()
                return { success: true, data: result }
            default:
                throw new Error(`Unsupported disk method: ${method}`)
        }
    }
}

/**
 * Load the platform disk implementation only when a database is created.
 * The database engine and Tree stay platform-neutral; platform details remain
 * contained by disk.
 */
export async function createPlatformDisk(options = {}) {
    if (options.storage) return { storage: options.storage, disk: createStorageDisk(options.storage) }

    const isNode = typeof globalThis.process?.versions?.node === 'string'
    if (!isNode) {
        const { ClientStorage } = await import('./client.js')
        const storage = new ClientStorage(options.directory ?? 'CoCreateDB')
        return { storage, disk: createStorageDisk(storage) }
    }

    const serverAdapter = './server.js'
    const { ServerStorage } = await import(/* webpackIgnore: true */ serverAdapter)
    const storage = new ServerStorage(options.directory)
    return { storage, disk: createStorageDisk(storage) }
}
