import { AsyncLocalStorage } from 'node:async_hooks'
import { sep } from 'node:path'
import { fileId } from './files.js'

// Temporary references only. Nothing here is persisted or added to CRUD payloads.
const requests = new AsyncLocalStorage()
export const currentResolution = () => requests.getStore()
export const withResolution = (operation, resolved = currentResolution()) =>
    requests.run(resolved ?? { catalogs: [], files: Object.create(null) }, operation)

export function afterResponse(operation) {
    const context = currentResolution()
    if (!context?.reading || !context.background) return false
    context.background.push(operation)
    return true
}

export function resolvedCatalog(index, database, array) {
    const resolved = currentResolution()
    if (!resolved) return
    let catalog = resolved.catalogs.find(item => item.index === index && item.database === database && item.array === array)
    if (!catalog) {
        catalog = { index, database, array, ids: Object.create(null), names: Object.create(null) }
        resolved.catalogs.push(catalog)
    }
    return catalog
}

export function retainRecord(index, database, array, file, record) {
    const catalog = resolvedCatalog(index, database, array)
    if (catalog && record) {
        catalog.ids[record._id] = fileId(record)
        if (typeof record.name === 'string') catalog.names[record.name] = record
        currentResolution().files[file] = record
    }
    return record
}

export function forgetResolvedPath(path, recursive = false) {
    const resolved = currentResolution()
    if (!resolved) return
    for (const file of recursive ? Object.keys(resolved.files) : [path]) {
        if (file !== path && !(recursive && file.startsWith(path + sep))) continue
        const record = resolved.files[file]
        if (!record) continue
        for (const catalog of resolved.catalogs) {
            if (catalog.ids[record._id] === fileId(record)) delete catalog.ids[record._id]
            if (catalog.names[record.name] === record) delete catalog.names[record.name]
        }
        delete resolved.files[file]
    }
}
