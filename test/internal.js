import { createConfiguration, createRootManager } from '../src/root.js'
import { crud } from '../src/crud/index.js'
export async function internal(options = {}) {
    const db = { config: createConfiguration(options), leaves: new Map(), tree: new Map(), persistence: { pending: Object.create(null) } }
    const roots = await createRootManager({ db, size: options.size })
    return { ...db, roots, get config() { return roots.configuration() }, send: request => crud({ db, roots }, request) }
}
