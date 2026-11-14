import { join } from 'node:path'
import { readdir } from './io.js'
import { readJSON, replaceJSON } from './storage.js'

export const FORMAT = 'cocreate-uuid-v1'

/** Refuse an old dataset before creating anything in its directory. */
export async function readRoot(directory) {
    const root = await readJSON(join(directory, 'root.json'))
    if (root) {
        if (root.format !== FORMAT) throw new Error('Unsupported database format; use a separate path or migrate the existing dataset')
        return root
    }
    for (const folder of ['storages', 'databases', 'arrays', 'objects', 'indexes', 'values', 'deleted', 'distribution']) {
        try {
            if ((await readdir(join(directory, folder))).length)
                throw new Error('Existing database files have no UUID root.json; use a separate path or migrate the existing dataset')
        } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
}

export async function ensureRoot(directory, index, database, array, field, onChange) {
    let root = await readRoot(directory)
    const id = index.catalogId(database, array)
    if (root && root[field] !== id) throw new Error('Database root does not match its catalog')
    if (!root) {
        root = { format: FORMAT, [field]: id }
        await index.ensureCatalog(database, array)
        await replaceJSON(join(directory, 'root.json'), root)
        await onChange?.(root)
    }
    return root
}
