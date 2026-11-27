const path = key => key.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean).join('.')
const scalar = value => value === null || value === undefined || ['string', 'number', 'boolean'].includes(typeof value)
const operators = new Set(['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$exists', '$type', '$not', '$includes', '$regex', '$options', '$mod'])
const every = nodes => nodes.length ? { kind: 'and', nodes, estimate: Math.min(...nodes.map(node => node.estimate ?? Infinity)) } : { kind: 'all' }

function indexedCondition(value) {
    if (scalar(value)) return true
    if (Array.isArray(value)) return value.length === 0
    if (!value || typeof value !== 'object') return false
    const keys = Object.keys(value)
    return keys.every(key => operators.has(key) && (key !== '$not' || indexedCondition(value[key])))
}

function expression(query, fields) {
    if (query == null) return { kind: 'all' }
    if (Array.isArray(query)) return every(query.map(part => expression(part, fields)))
    if (typeof query !== 'object') return { kind: 'none' }
    return every(Object.entries(query).map(([key, condition]) => {
        if (['$and', '$or', '$nor'].includes(key)) {
            if (!Array.isArray(condition)) return { kind: 'none' }
            const nodes = condition.map(part => expression(part, fields))
            if (key === '$and') return every(nodes)
            const union = { kind: 'or', nodes }
            return key === '$nor' ? { kind: 'not', node: union } : union
        }
        if (key === '$where') return { kind: 'residual' }
        if (key.startsWith('$')) return { kind: 'none' }
        const sources = fields.filter(field => path(field.key) === path(key))
        const container = fields.some(field => path(field.key).startsWith(`${path(key)}.`))
        if (container || !indexedCondition(condition)) return { kind: 'residual' }
        return { kind: 'field', key: path(key), condition, sources, estimate: sources.reduce((sum, field) => sum + (field.count ?? Infinity), 0) / (scalar(condition) ? typeof condition === 'boolean' ? 2 : 16 : 1) }
    }))
}

/** Pure query planning. Index I/O and leaf hydration belong to getLeaves(plan). */
export default function planner(branch, query = {}, filter = { limit: 0 }) {
    const start = filter.startingIndex ?? filter.index ?? 0
    const limit = filter.limit ?? 50
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(limit) || limit < 0)
        throw new Error('invalid pagination')
    if (filter.sort !== undefined && !Array.isArray(filter.sort)) throw new TypeError('filter.sort must be an array')
    const sort = (filter.sort ?? []).filter(item => item?.key).map(({ key, direction }) => {
        if (typeof key !== 'string') throw new TypeError('Sort keys must be strings')
        return { key, direction: direction === 'desc' ? 'desc' : 'asc' }
    })
    const fields = branch?.fields ?? []
    return {
        kind: 'query', target: branch?.target, primary: branch?.parent?.uuid, fields,
        expression: !branch || branch.missing ? { kind: 'none' } : expression(query, fields),
        query, sort, start, limit: limit || Infinity, search: filter.search
    }
}
