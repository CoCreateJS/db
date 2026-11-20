import { queryData } from '@cocreate/utils'

const scalar = value => value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'number' && Number.isFinite(value)

const ordered = value => value !== null &&
    (typeof value === 'string' || typeof value === 'boolean' ||
        typeof value === 'number' && Number.isFinite(value))

function indexBounds(condition) {
    if (scalar(condition)) return { value: condition, min: condition, max: condition }
    if (!condition || typeof condition !== 'object' || Array.isArray(condition) || condition instanceof Date)
        return null

    const entries = Object.entries(condition)
    if (!entries.length || entries.some(([operator]) =>
        !['$eq', '$gt', '$gte', '$lt', '$lte'].includes(operator))) return null

    const equality = entries.find(([operator]) => operator === '$eq')
    if (equality) {
        if (entries.length !== 1 || !scalar(equality[1])) return null
        return { value: equality[1], min: equality[1], max: equality[1] }
    }

    if (entries.length > 2 || entries.some(([, value]) => !ordered(value))) return null
    const type = typeof entries[0][1]
    if (entries.some(([, value]) => typeof value !== type)) return null

    const lower = entries.find(([operator]) => operator === '$gt' || operator === '$gte')
    const upper = entries.find(([operator]) => operator === '$lt' || operator === '$lte')
    if (entries.length === 2 && (!lower || !upper)) return null

    return {
        value: entries[0][1],
        min: lower?.[1],
        max: upper?.[1]
    }
}

export function queryTree(scope, query = {}, limit = Infinity) {
    if (limit <= 0) return []
    if (typeof query.uuid === 'string') {
        const object = scope.artifacts.get(query.uuid)
        return object && queryData(object, query) ? [object] : []
    }

    let candidate
    for (const [key, condition] of Object.entries(query)) {
        if (key.startsWith('$')) continue
        const bounds = indexBounds(condition)
        if (!bounds) continue
        const tree = scope.tree.get(key)?.get(bounds.value === null ? 'null' : typeof bounds.value)
        if (!tree) continue
        if (!candidate || tree.root.length < candidate.tree.root.length)
            candidate = { tree, min: bounds.min, max: bounds.max }
    }

    const source = candidate
        ? (function* () {
            for (const entry of candidate.tree.scan(candidate.min, candidate.max)) yield entry.object
        })()
        : scope.artifacts.values()
    const result = []
    for (const object of source) {
        if (!queryData(object, query)) continue
        result.push(object)
        if (result.length >= limit) break
    }
    return result
}
