import { createDistribution } from './distribution/index.js'
import { crud } from './crud/index.js'
import { persistence as defaults } from './persistence.js'
import { createConfiguration, createScopeManager } from './Scope.js'

export default function createDB(server = { isPrimary: true }, options = {}) {
    const { persistence = defaults, forward, size = 64 } = options
    const configuration = createConfiguration(options)
    const primary = !!server.isPrimary
    const artifacts = primary ? new Map() : null
    const tree = primary ? new Map() : null
    const db = {
        config: configuration,
        scopes: configuration.scopes,
        artifacts,
        tree,
        distribution: createDistribution(server),
        async send(request) {
            if (!primary) {
                if (!forward) throw Error('worker IPC adapter required')
                return forward(request)
            }
            return crud({ db, scopes: manager, persistence, size }, request)
        }
    }
    const manager = primary ? createScopeManager({ db, size }) : null
    return db
}
