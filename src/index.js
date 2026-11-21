import {ArtifactTier} from './tree/artifacts.js'
import { MemoryPolicy } from './tree/memory.js'
import { LocalTier } from './tree/local.js'
import Config from '@cocreate/config'
import { crud } from './crud/index.js'
import { createConfiguration, createScopeManager } from './scope.js'

export function createDB(server = {}, options = {}) {
    const { forward, size = 1024, leafSize = size } = options
    const configuration = createConfiguration(options)
    const primary = server.isPrimary ?? (server.isWorker === true ? false : true)
    const db = { config: configuration, artifacts: new Map(), tree: new Map(), deleting: new Set() }
    if (options.directory) {
        db.local = new LocalTier(options.directory, undefined, {
            resolveArtifact: id => (db.artifacts.reference?.(id) ?? db.artifacts.get(id)) ?? db.deleted?.get(id)
        })
    }
    if(primary && db.local)db.artifacts=new ArtifactTier(db.local)
    const policy = primary && db.local && options.memoryPolicy !== false ? new MemoryPolicy(db.local, {memory:options.config?.memory??25,...options.memoryPolicy},db.artifacts) : null
    const scopes = createScopeManager({ db, size, leafSize, deferIndex: options.deferIndex ?? true })
    if(db.artifacts instanceof ArtifactTier){db.artifacts.pending=scopes.pendingIndex}
    const api = {
        ... (db.local ? {local:db.local,artifactTier:db.artifacts} : {}),
        get config() { return scopes.configuration(primary) },
        async send(request) {
            if (!primary) {
                if (!forward) throw Error('worker IPC adapter required')
                return forward(request)
            }
            const result = await crud({ db, scopes }, request)
            policy?.check()
            if(policy?.error)throw policy.error
            return result
        }
    }
    Object.defineProperties(api, {memoryPolicy: {value: policy},flushIndex: {value: scopes.flushIndex}, pendingIndexCount: {get: () => scopes.pendingIndex.size}})
    return api
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
