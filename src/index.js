import Config from '@cocreate/config'
import { crud } from './crud/index.js'
import { createConfiguration, createScopeManager } from './scope.js'

export function createDB(server = {}, options = {}) {
    const { forward, size = 64 } = options
    const configuration = createConfiguration(options)
    const primary = server.isPrimary ?? (server.isWorker === true ? false : true)
    const db = { config: configuration, artifacts: new Map(), tree: new Map() }
    const scopes = createScopeManager({ db, size })
    return {
        get config() { return scopes.configuration(primary) },
        async send(request) {
            if (!primary) {
                if (!forward) throw Error('worker IPC adapter required')
                return forward(request)
            }
            return crud({ db, scopes }, request)
        }
    }
}

export async function init(server = {}, options = {}) {
    const primary = server.isPrimary ?? (server.isWorker === true ? false : true)
    const resolved = primary && options.prompt !== false
        ? await Config.prompt(options.config === undefined ? (options.questions ?? { db: {} }) : { db: {} }, true, options.config === undefined && options.questions !== undefined)
        : {}
    const config = {
        ...(resolved?.db ?? {}),
        ...(options.config ?? {})
    }
    return createDB(server, { ...options, config })
}

createDB.init = init
export default createDB
