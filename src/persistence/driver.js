import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const directories = [
    process.env.COCREATE_PERSISTENCE_DIR,
    process.env.COCREATE_STORAGE_DIR,
    ...['persistences', 'storages'].flatMap(name => [
        path.resolve(process.cwd(), name),
        process.argv[1] ? path.resolve(path.dirname(process.argv[1]), name) : null
    ])
].filter((directory, index, all) => directory && all.indexOf(directory) === index)

const aliases = {
    auroradb: 'postgresql', cockroachdb: 'postgresql', cosmosdb: 'mongodb',
    documentdb: 'mongodb', dqlite: 'sqlite', ferretdb: 'mongodb', mariadb: 'mysql',
    oracledb: 'mongodb', planetscale: 'mysql', tidb: 'mysql', timescaledb: 'postgresql',
    turso: 'sqlite', yugabytedb: 'postgresql'
}

export const persistenceDrivers = new Map()

function instantiate(module) {
    let driver = module?.default ?? module
    if (typeof driver === 'function') {
        try { driver = new driver() }
        catch { /* A callable driver may not be a constructor. */ }
    }
    return driver
}

export function registerPersistenceDriver(provider, driver) {
    if (!provider || !driver) return
    const key = provider.toLowerCase()
    const instance = instantiate(driver)
    persistenceDrivers.set(key, instance)
    persistenceDrivers.set(aliases[key] || key, instance)
    return instance
}

/** Load a persistence driver from the runtime cache or a persistences directory. */
export async function getPersistenceDriver(provider) {
    if (typeof provider !== 'string' || !provider.trim())
        throw new Error('A persistence provider name is required.')

    const key = provider.trim().toLowerCase()
    const resolved = aliases[key] || key
    if (persistenceDrivers.has(key)) return persistenceDrivers.get(key)
    if (persistenceDrivers.has(resolved)) return persistenceDrivers.get(resolved)

    for (const directory of directories) {
        const file = path.join(directory, `${resolved}.js`)
        if (!fs.existsSync(file)) continue
        const module = await import(/* webpackIgnore: true */ pathToFileURL(file).href)
        const driver = registerPersistenceDriver(key, module)
        if (typeof driver?.send !== 'function')
            throw new Error(`Persistence driver "${provider}" must implement send().`)
        return driver
    }

    throw new Error(`Persistence driver "${provider}" was not found in: ${directories.join(', ')}`)
}
