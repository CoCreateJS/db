import { createConfiguration, createRootManager } from '../src/root.js'
import { crud } from '../src/crud/index.js'
export function internal(options = {}) {
    const db = { config: createConfiguration(options), leaves: new Map(), tree: new Map() }
    const roots = createRootManager({ db, size: options.size })
    return { ...db, roots, get config() { return roots.configuration() }, send: request => crud({ db, roots }, request) }
}
