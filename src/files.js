import { randomUUID, createHash } from 'node:crypto'
import { basename, join } from 'node:path'
import { live } from './mutation.js'

// File identity is runtime metadata, not a field of the user's document.
const identity = Symbol('fileId')
export const newFileId = () => randomUUID().replaceAll('-', '')
export const fileId = value => live(value)?.[identity]
export const inheritIdentity = (source, view) => fileId(source) ? identify(view, fileId(source)) : view
export function identify(value, id) {
    value = live(value)
    if (!/^[a-f0-9]{32}$/i.test(id)) throw new TypeError('A UUID file ID is required')
    Object.defineProperty(value, identity, { value: id, configurable: true })
    return value
}
export const fileIdFromPath = path => basename(path, '.json')
export function recordPath(root, type, id) {
    if (!/^[a-f0-9]{32}$/i.test(id)) throw new TypeError('A UUID file ID is required')
    return join(root, type, `${id}.json`)
}

export const stableId = value => createHash('sha256').update(value.replaceAll('\\', '/')).digest('hex').slice(0, 32)
