import { createHash } from 'node:crypto'
import { flattenIndexValues } from './storage.js'

// Hash terminal arrays without constructing a canonical copy of their contents.
export function arrayDigest(value) {
    const hash = createHash('sha256')
    const visit = item => {
        if (item === undefined) { hash.update('undefined'); return }
        if (item === null) { hash.update('null'); return }
        if (ArrayBuffer.isView(item) || item instanceof ArrayBuffer) {
            const bytes = item instanceof ArrayBuffer
                ? Buffer.from(item)
                : Buffer.from(item.buffer, item.byteOffset, item.byteLength)
            hash.update(`binary:${item.constructor.name}:${bytes.length}:`)
            hash.update(bytes)
            return
        }
        if (Array.isArray(item)) {
            hash.update('[')
            for (let i = 0; i < item.length; i++) {
                if (i) hash.update(',')
                hash.update(Object.hasOwn(item, i) ? 'value:' : 'hole:')
                visit(item[i])
            }
            hash.update(']')
        } else if (item && typeof item === 'object') {
            hash.update('{')
            let first = true
            for (const key of Object.keys(item).sort()) {
                if (!first) hash.update(',')
                first = false
                hash.update(JSON.stringify(key) + ':')
                visit(item[key])
            }
            hash.update('}')
        } else hash.update(`${typeof item}:${JSON.stringify(item)}`)
    }
    visit(value)
    return hash.digest('hex')
}

// Before-state consists of index keys/scalars/digests, never a document snapshot.
export function indexEntries(record) {
    return flattenIndexValues(record ?? {}).map(([key, value]) => ({ key, value,
        type: Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value,
        indexed: Array.isArray(value) ? arrayDigest(value) : value }))
}
export const entryKey = entry => JSON.stringify([entry.key, entry.type, entry.indexed])
