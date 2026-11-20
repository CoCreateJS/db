import { createConfiguration, createScopeManager } from '../src/scope.js'
import { crud } from '../src/crud/index.js'
export function internal(options = {}) {
    const db = { config: createConfiguration(options), artifacts: new Map(), tree: new Map() }
    const scopes = createScopeManager({ db, size: options.size })
    return { ...db, scopes, get config() { return scopes.configuration() }, send: request => crud({ db, scopes }, request) }
}
