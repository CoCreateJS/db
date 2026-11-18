import { createHash } from 'node:crypto'
import { uuid } from '@cocreate/utils'
import { basename, join } from 'node:path'
import { live } from './mutation.js'

// Keep the persistent artifact UUID visible on the value and its internal alias hidden.
const identity = Symbol('fileId')
export const newFileId = () => uuid().replaceAll('-', '')
export const fileId = value => live(value)?.[identity] ?? live(value)?.uuid
export const inheritIdentity = (source, view) => fileId(source) ? identify(view, fileId(source)) : view
export function identify(value, id) {
    value = live(value)
    if (!/^[a-f0-9]{32}$/i.test(id)) throw new TypeError('A UUID file ID is required')
    id = id.toLowerCase()
    if (value.uuid !== undefined && String(value.uuid).toLowerCase() !== id) throw new Error('Artifact UUID cannot be changed')
    Object.defineProperty(value, 'uuid', { value: id, enumerable: true, writable: false, configurable: false })
    Object.defineProperty(value, identity, { value: id, configurable: false })
    return value
}
export const fileIdFromPath = path => basename(path, '.json')
export function recordPath(root, type, id) {
    if (!/^[a-f0-9]{32}$/i.test(id)) throw new TypeError('A UUID file ID is required')
    return join(root, 'data', type === 'objects' ? `${id}.coson` : id)
}

export const stableId = value => createHash('sha256').update(value.replaceAll('\\', '/')).digest('hex').slice(0, 32)
