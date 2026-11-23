import { createDatabase } from '../database.js'
import { OPFSStorage } from './storage.js'

export async function createDB(server = {}, options = {}) {
    const mode = options.mode ?? options.config?.mode ?? 'disk-first'
    if (!['adaptive', 'disk-first', 'disk-cache'].includes(mode)) throw new Error(`Unsupported database mode: ${mode}`)
    const acknowledgement = options.acknowledgement ?? options.config?.acknowledgement ?? 'memory'
    if (!['memory', 'disk', 'persistence'].includes(acknowledgement)) throw new Error(`Unsupported acknowledgement: ${acknowledgement}`)
    if (acknowledgement === 'persistence') throw new Error('Persistence acknowledgement requires an external persistence integration with the complete persistence tree')
    const baseDirectory = options.directory ?? 'CoCreateDB'
    const storage = new OPFSStorage(baseDirectory)

    if (mode === 'disk-cache') await storage.clear()
    else await storage.initialize()

    let configurationOptions = options
    if (mode !== 'disk-cache') {
        try { configurationOptions = { config: JSON.parse(await storage.readConfig()) } }
        catch (error) { if (error.name !== 'NotFoundError') throw error }
    }

    return await createDatabase(server, options, {
        primary: true,
        baseDirectory,
        storage,
        configurationOptions,
        defaultMode: 'disk-first',
        forceDiskFirst: true,
        memoryPolicy: false,
        persistConfig: async value => await storage.writeConfig(JSON.stringify(value))
    })
}

export async function init(server = {}, options = {}) {
    return await createDB(server, options)
}

createDB.init = init
export default createDB
