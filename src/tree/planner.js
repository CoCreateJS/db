const indexedTypes = new Set(['string', 'number', 'boolean'])
const rangeOperators = new Set(['$gt', '$gte', '$lt', '$lte'])
const hasOwn = (value, key) => Object.hasOwn(value, key)

function bounds(condition) {
    if (condition === null || typeof condition !== 'object' || Array.isArray(condition)) {
        return { min: condition, max: condition, equality: true }
    }

    if (hasOwn(condition, '$eq')) return { min: condition.$eq, max: condition.$eq, equality: true }
    const keys = Object.keys(condition)
    if (!keys.length || keys.some(key => !rangeOperators.has(key))) return undefined
    const lower = hasOwn(condition, '$gte') ? condition.$gte : condition.$gt
    const upper = hasOwn(condition, '$lte') ? condition.$lte : condition.$lt
    const min = lower
    const max = upper
    const values = [min, max].filter(value => value !== undefined)
    if (!values.length || values.some(value => value === null || !indexedTypes.has(typeof value))) return undefined
    if (values.some(value => typeof value === 'number' && !Number.isFinite(value))) return undefined
    if (values.some(value => typeof value !== typeof values[0])) return undefined
    return { min, max, equality: false }
}

function overlaps(branch, min, max) {
    if (min !== undefined && branch.lastValue < min) return false
    if (max !== undefined && branch.firstValue > max) return false
    return true
}

function conjunctions(query, output = []) {
    for (const [key, value] of Object.entries(query ?? {})) {
        if (key === '$and' && Array.isArray(value)) {
            for (const clause of value) {
                if (clause && typeof clause === 'object' && !Array.isArray(clause)) conjunctions(clause, output)
            }
        } else if (!key.startsWith('$')) output.push([key, value])
    }
    return output
}

/** Choose one safe indexed candidate; CRUD verifies the complete predicate. */
export default function planner(rootBranch, query = {}) {
    if (!rootBranch || rootBranch.missing) return { strategy: 'none', branches: [], estimatedCount: 0 }
    if (!query || typeof query !== 'object' || Array.isArray(query)) return { strategy: 'scan', branches: [], estimatedCount: Infinity }

    const candidates = []
    for (const [key, condition] of conjunctions(query)) {
        // A conjunctive clause is a safe superset candidate. `$or` is omitted
        // here because it requires union semantics to avoid missing matches.
        if (key.includes('[') || /(^|\.)\d+(\.|$)|^\.|\.$|\.\./.test(key)) continue
        const range = bounds(condition)
        if (!range) continue
        const type = typeof range.min === 'object' || range.min === undefined
            ? typeof range.max
            : typeof range.min
        if (type === 'object' || type === 'undefined' || !indexedTypes.has(type)) continue
        const field = rootBranch.fields.find(item => item.key === key && item.type === type)
        if (!field) continue
        const branches = field.branches.length
            ? field.branches.filter(branch => overlaps(branch, range.min, range.max))
            : [{ uuid: field.uuid, length: field.count, firstValue: field.min, lastValue: field.max }]
        candidates.push({
            strategy: 'index',
            key,
            type,
            min: range.min,
            max: range.max,
            equality: range.equality,
            branches,
            estimatedCount: branches.reduce((count, branch) => count + branch.length, 0)
        })
    }

    if (!candidates.length) return { strategy: 'scan', branches: [], estimatedCount: Infinity }
    candidates.sort((a, b) => a.estimatedCount - b.estimatedCount || a.key.localeCompare(b.key))
    return candidates[0]
}
