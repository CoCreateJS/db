const TAG = '\0cocreate.db.value'

function encode(value, ancestors = new Set()) {
    if (value === undefined) return { [TAG]: 'undefined' }
    if (value === null || typeof value !== 'object') return value

    if (typeof value.toJSON === 'function') return encode(value.toJSON(), ancestors)
    if (ancestors.has(value)) throw new TypeError('Cannot serialize cyclic database values')
    ancestors.add(value)

    let result
    if (Array.isArray(value)) {
        result = Array.from({ length: value.length }, (_, index) => encode(value[index], ancestors))
    } else {
        const entries = Object.keys(value).map(key => [key, encode(value[key], ancestors)])
        result = Object.hasOwn(value, TAG)
            ? { [TAG]: 'object', entries }
            : Object.fromEntries(entries)
    }

    ancestors.delete(value)
    return result
}

function decode(value) {
    if (!value || typeof value !== 'object') return value
    if (!Array.isArray(value) && value[TAG] === 'undefined') return undefined
    if (!Array.isArray(value) && value[TAG] === 'object') {
        const result = {}
        for (const [key, entry] of value.entries) Object.defineProperty(result, key, {
            value: decode(entry), enumerable: true, writable: true, configurable: true
        })
        return result
    }
    if (Array.isArray(value)) return value.map(decode)
    for (const key of Object.keys(value)) Object.defineProperty(value, key, {
        value: decode(value[key]), enumerable: true, writable: true, configurable: true
    })
    return value
}

export const stringifyValue = value => JSON.stringify(encode(value))
export const parseValue = value => decode(JSON.parse(value))
