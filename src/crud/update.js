import { updateLeaf } from '../leaf.js'

const record = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
const operators = new Set(['$set', '$rename', '$inc', '$push', '$each', '$splice', '$unset', '$delete', '$slice', '$pop', '$shift', '$addToSet', '$pull'])
const forbidden = new Set(['__proto__', 'prototype', 'constructor'])

function timestamp(value) {
    if (value === undefined || value === null) return undefined
    const time = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN
    if (!Number.isFinite(time)) throw Error('invalid updated.on')
    return time
}

function pathParts(path) {
    const parts = path.split('.')
    if (parts.some(key => !key || forbidden.has(key))) throw Error('invalid update path')
    return parts
}

function missing(object, parts) {
    for (let i = 0; i < parts.length; i++) {
        if (!record(object) && i !== 0) return false
        if (!Object.hasOwn(object, parts[i])) return true
        object = object[parts[i]]
    }
    return false
}

function retainMissing(object, path, value, accepted, prefix = '') {
    const parts = pathParts(path)
    if (['uuid', '_id', 'root', 'parent', 'updated'].includes(parts[0])) return
    if (parts.some(key => /[\[\]]/.test(key) || /^\d+$/.test(key))) return
    if (value === undefined || typeof value === 'string' && operators.has(value)) return
    if (record(value) && Object.keys(value).length) {
        for (const [key, child] of Object.entries(value)) retainMissing(object, `${path}.${key}`, child, accepted, prefix)
    } else if (missing(object, parts)) accepted[prefix + path] = value
}

function olderPatch(object, patch) {
    const accepted = {}
    for (const [key, value] of Object.entries(patch)) {
        if (key === '$set') {
            if (!record(value)) throw Error('invalid $set')
            for (const [path, child] of Object.entries(value)) retainMissing(object, path, child, accepted, '$set.')
        } else if (key.startsWith('$set.')) retainMissing(object, key.slice(5), value, accepted, '$set.')
        else if (!key.startsWith('$')) retainMissing(object, key, value, accepted)
    }
    return accepted
}

export function update(object, input, global = {}) {
    const { uuid, _id, $update, ...fields } = input
    const patch = { ...fields, ...global, ...$update }
    const supplied = [patch.updated?.on, patch['updated.on'], patch.$set?.updated?.on, patch.$set?.['updated.on'], patch['$set.updated']?.on, patch['$set.updated.on']].filter(value => value !== undefined)
    const incoming = timestamp(supplied[0])
    if (supplied.some(value => timestamp(value) !== incoming)) throw Error('conflicting updated.on')
    const previous = timestamp(object.updated?.on)
    const stale = previous !== undefined && incoming !== undefined && incoming <= previous
    const applied = stale ? olderPatch(object, patch) : patch
    const by = patch['updated.by'] ?? patch.updated?.by ?? patch['$set.updated.by'] ?? patch['$set.updated']?.by ?? patch.$set?.['updated.by'] ?? patch.$set?.updated?.by
    const audit = stale ? { 'updated.on': supplied[0], ...(by !== undefined ? { 'updated.by': by } : {}) } : {}
    const mutation = Object.keys(applied).length ? structuredClone({ ...applied, ...audit, uuid: object.uuid, ...(object._id !== undefined ? { _id: object._id } : {}) }) : undefined
    if (mutation) updateLeaf(object, applied)
    return { object: structuredClone(object), mutation }
}
