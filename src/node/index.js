import { homedir } from 'node:os'
import { join } from 'node:path'
import Config from '@cocreate/config'
import { createDatabase } from '../database.js'
import { NodeStorage } from './storage.js'

export async function createDB(server = {}, options = {}) {
    const primary = server.isPrimary ?? (server.isWorker === true ? false : true)
    if (!primary) return await createDatabase(server, options, { primary })

    const mode = options.mode ?? options.config?.mode ?? 'adaptive'
    const baseDirectory = options.directory ?? join(homedir(), '.cocreate', 'db')
    const storage = new NodeStorage(baseDirectory)
    if (mode === 'disk-cache') await storage.clear()
    else await storage.initialize()

    let configurationOptions = options
    if (mode !== 'disk-cache') {
        try { configurationOptions = { config: JSON.parse(await storage.readConfig()) } }
        catch (error) { if (error.code !== 'ENOENT') throw error }
    }

    return await createDatabase(server, options, {
        primary,
        baseDirectory,
        storage,
        configurationOptions,
        persistConfig: async value => await storage.writeConfig(JSON.stringify(value))
    })
}

export async function init(server = {}, options = {}) {
    const primary = server.isPrimary ?? (server.isWorker === true ? false : true)
    const resolved = primary && options.prompt !== false
        ? await Config.prompt(options.config === undefined ? (options.questions ?? { db: {} }) : { db: {} }, true, options.config === undefined && options.questions !== undefined)
        : {}
    const config = { ...(resolved?.db ?? {}), ...(options.config ?? {}) }
    return await createDB(server, { ...options, config })
}

createDB.init = init
export default createDB
