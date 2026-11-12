import { queryData } from '@cocreate/utils'

const typeOf = value => value === null ? 'null' :
    Array.isArray(value) ? 'array' :
    typeof value === 'boolean' ? 'boolean' :
        typeof value === 'string' ? 'string' :
            typeof value === 'number' && Number.isFinite(value) ? 'number' : null

export function normalizeQuery(request) {
    const query = request.filter?.query ?? request.object?.filter?.query
    let normalized

    if (Array.isArray(query)) {
        normalized = {
            $and: query.map(({ key, value, operator = '$eq' }) => ({
                [key]: { [operator]: value }
            }))
        }
    } else if (query && typeof query === 'object') {
        normalized = query
    } else {
        const objects = request.object === undefined
            ? []
            : Array.isArray(request.object) ? request.object : [request.object]
        const first = objects[0]

        if (typeof first === 'string') normalized = { _id: first }
        else if (!first || typeof first !== 'object' || Array.isArray(first)) normalized = {}
        else normalized = Object.fromEntries(Object.entries(first)
            .filter(([key]) => key !== 'filter' && !key.startsWith('$')))
    }

    return request.organization_id
        ? { ...normalized, organization_id: request.organization_id }
        : normalized
}

export function hasQueryConditions(query) {
    return query && typeof query === 'object' && Object.keys(query).length > 0
}

const intersect = (left, right) => new Set([...left].filter(value => right.has(value)))
const union = (left, right) => new Set([...left, ...right])

/**
 * Compile Mongo-style query conditions into candidate ObjectId sets.
 * Unsupported predicates conservatively return the full ID universe and are
 * checked against hydrated records by queryData.
 */
export async function queryIndexCandidates(index, database, array, query, { readObject } = {}) {
    const metadata = new Map()
    const getMetadata = key => {
        if (!metadata.has(key)) metadata.set(key, (index.getMetadata ?? index.get).call(index, database, array, key))
        return metadata.get(key)
    }
    const hasArrayAncestor = async key => {
        const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.')
        for (let i = 1; i < parts.length; i++)
            if ((await getMetadata(parts.slice(0, i).join('.'))).indexes.array) return true
        return false
    }
    let allIdsPromise
    const allIds = () => {
        if (!allIdsPromise) allIdsPromise = (async () => {
            const ids = new Set()
            for await (const entry of index.scan(database, array, '_id', { type: 'string' }))
                ids.add(entry.objectId)
            return ids
        })()
        return allIdsPromise
    }

    const all = async exact => ({ ids: new Set(await allIds()), exact })
    const empty = exact => ({ ids: new Set(), exact })

    const scan = async (key, type, predicate, range) => {
        const root = await getMetadata(key)
        if (!Object.keys(root.indexes).length) return all(false)
        if (!root.indexes[type]) return empty(true)
        const branch = root.indexes[type]
        if (type !== 'array' && branch.first && branch.last && (
            range?.lower !== undefined && (branch.last.value < range.lower ||
                range.lowerOpen && branch.last.value === range.lower) ||
            range?.upper !== undefined && (branch.first.value > range.upper ||
                range.upperOpen && branch.first.value === range.upper)
        )) return empty(true)
        const ids = new Set()
        for await (const entry of index.scan(database, array, key, { type, ...range }))
            if (predicate(entry.value)) ids.add(entry.objectId)
        return { ids, exact: true }
    }

    const scanArrays = async (key, predicate = () => true, range) =>
        scan(key, 'array', predicate, range)

    const equality = async (key, value, condition = { $eq: value }) => {
        const type = typeOf(value)
        if (!type) return all(false)
        if (type === 'array')
            return scanArrays(key, candidate => queryData({ value: candidate }, { value: condition }))

        const scalar = await scan(key, type, candidate => Object.is(candidate, value), { lower: value, upper: value })
        const arrays = await scanArrays(key, candidate => queryData({ value: candidate }, { value }))
        return {
            ids: union(scalar.ids, arrays.ids),
            exact: scalar.exact && arrays.exact
        }
    }

    const range = async (key, operator, value) => {
        // Plain objects are not terminal value-index entries, but native JS
        // comparisons can coerce them to strings. Do not exclude those records
        // by treating the scalar branches as a complete candidate set.
        if (key !== '_id' && (typeof value === 'string' || value && typeof value === 'object'))
            return all(false)
        const root = await getMetadata(key)
        const matches = new Set()
        const operators = {
            '$gt': (candidate, query) => candidate > query,
            '$gte': (candidate, query) => candidate >= query,
            '$lt': (candidate, query) => candidate < query,
            '$lte': (candidate, query) => candidate <= query
        }

        // Values are intentionally compared with JavaScript's native operators.
        // Check every indexed type branch so coercive JS comparisons cannot be
        // lost by restricting the scan to the query value's own type branch.
        for (const type of Object.keys(root.indexes || {}).filter(type => type !== 'array')) {
            // Prune only same-type numeric/string branches. Other branches retain
            // native JS coercion semantics and must be checked without bounds.
            const bounded = ['number', 'string'].includes(type) && typeOf(value) === type
            const bounds = !bounded ? {} : operator === '$gt' || operator === '$gte'
                ? { lower: value, lowerOpen: operator === '$gt' }
                : { upper: value, upperOpen: operator === '$lt' }
            const result = await scan(key, type, candidate => operators[operator](candidate, value), bounds)
            for (const objectId of result.ids) matches.add(objectId)
        }

        const arrays = await scanArrays(key, candidate => queryData(
            { value: candidate },
            { value: { [operator]: value } }
        ))
        for (const objectId of arrays.ids) matches.add(objectId)

        return { ids: matches, exact: arrays.exact }
    }

    const combineAnd = async results => {
        if (!results.length) return all(true)
        results.sort((left, right) => left.ids.size - right.ids.size)
        let result = results[0]
        for (const next of results.slice(1)) {
            result = { ids: intersect(result.ids, next.ids), exact: result.exact && next.exact }
            if (!result.ids.size) break
        }
        return result
    }

    // Length is a conservative work estimate, not a distinct-value statistic.
    // Array predicates inspect terminal values; prefer bounded scalar lookups.
    const estimate = async expression => {
        if (Array.isArray(expression)) return Math.min(Infinity, ...await Promise.all(expression.map(estimate)))
        if (!expression || typeof expression !== 'object') return Infinity
        const costs = []
        for (const [key, condition] of Object.entries(expression)) {
            if (key === '$and' && Array.isArray(condition)) costs.push(await estimate(condition))
            else if (key === '$or' && Array.isArray(condition))
                costs.push((await Promise.all(condition.map(estimate))).reduce((sum, cost) => sum + cost, 0))
            else if (key.startsWith('$') || await hasArrayAncestor(key)) costs.push(Infinity)
            else {
                const root = await getMetadata(key)
                const branches = Object.values(root.indexes)
                if (!branches.length) { costs.push(Infinity); continue }
                const operator = condition && typeof condition === 'object' && !Array.isArray(condition)
                    ? condition : { $eq: condition }
                if (Object.keys(operator).some(name => ['$ne', '$nin', '$not', '$exists'].includes(name))) {
                    costs.push(Infinity)
                    continue
                }
                const equalityValue = Object.hasOwn(operator, '$eq') ? operator.$eq : undefined
                const type = typeOf(equalityValue)
                const branch = root.indexes[type]
                if (type && type !== 'array' && !root.indexes.array && branch?.first && branch?.last &&
                    (equalityValue < branch.first.value || equalityValue > branch.last.value)) {
                    costs.push(0)
                    continue
                }
                // _id is unique in object arrays. Its equality bound needs at most one entry.
                if (key === '_id' && typeof equalityValue === 'string' && !root.indexes.array) costs.push(1)
                else costs.push(Object.entries(root.indexes).reduce((sum, [type, item]) =>
                    sum + (item.length ?? Infinity) * (type === 'array' ? 4 : 1), 0))
            }
        }
        return Math.min(Infinity, ...costs)
    }

    const compileAnd = async expressions => {
        if (!expressions.length) return all(true)
        const planned = await Promise.all(expressions.map(async expression => ({ expression, cost: await estimate(expression) })))
        planned.sort((left, right) => left.cost - right.cost)
        let result
        for (const { expression, cost } of planned) {
            if (result && !result.ids.size) break
            if (result && readObject && result.ids.size <= 256 && result.ids.size * 4 < cost) {
                for (const objectId of result.ids) {
                    const object = await readObject(objectId)
                    if (!object || !queryData(object, expression)) result.ids.delete(objectId)
                }
            } else {
                const next = await compileRaw(expression)
                result = result ? await combineAnd([result, next]) : next
            }
        }
        return result
    }

    const compileField = async (key, condition) => {
        // Dotted indexes cover object leaves but not members of terminal arrays.
        // A present dotted index must not hide matching array-backed documents.
        if (await hasArrayAncestor(key)) return all(false)
        if (condition === null || condition === undefined || ['string', 'number', 'boolean'].includes(typeof condition))
            return equality(key, condition)
        if (Array.isArray(condition)) return equality(key, condition, condition)
        if (!condition || typeof condition !== 'object') return all(false)

        const operators = Object.keys(condition).filter(operator => operator.startsWith('$'))
        if (!operators.length) {
            const nested = []
            for (const [child, value] of Object.entries(condition))
                nested.push(await compileField(`${key}.${child}`, value))
            const result = await combineAnd(nested)
            return { ...result, exact: false }
        }

        const results = []
        for (const operator of operators) {
            const value = condition[operator]
            if (operator === '$options') continue

            if (operator === '$eq') {
                results.push(await equality(key, value))
            } else if (operator === '$ne') {
                const match = await equality(key, value)
                results.push(match.exact
                    ? { ids: new Set([...await allIds()].filter(id => !match.ids.has(id))), exact: true }
                    : await all(false))
            } else if (operator === '$not') {
                const match = await compileField(key, value)
                results.push(match.exact
                    ? { ids: new Set([...await allIds()].filter(id => !match.ids.has(id))), exact: true }
                    : await all(false))
            } else if (['$gt', '$gte', '$lt', '$lte'].includes(operator)) {
                results.push(await range(key, operator, value))
            } else if (operator === '$in' || operator === '$nin') {
                const choices = Array.isArray(value) ? value : [value]
                const matches = []
                for (const choice of choices) {
                    const type = typeOf(choice)
                    matches.push(type === 'array' ? empty(true) : !type ? await all(false) :
                        await scan(key, type, candidate => Object.is(candidate, choice), { lower: choice, upper: choice }))
                }
                let match = matches.reduce((result, next) => ({
                    ids: union(result.ids, next.ids),
                    exact: result.exact && next.exact
                }), { ids: new Set(), exact: true })
                const arrayMatch = await scanArrays(key, candidate => queryData(
                    { value: candidate },
                    { value: { $in: choices } }
                ))
                match = {
                    ids: union(match.ids, arrayMatch.ids),
                    exact: match.exact && arrayMatch.exact
                }
                results.push(operator === '$in'
                    ? match
                    : match.exact
                        ? { ids: new Set([...await allIds()].filter(id => !match.ids.has(id))), exact: true }
                        : await all(false))
            } else if (operator === '$all' && Array.isArray(value)) {
                results.push(await scanArrays(key, candidate => queryData(
                    { value: candidate },
                    { value: { $all: value } }
                )))
            } else if (operator === '$elemMatch' || operator === '$size') {
                results.push(await scanArrays(key, candidate => queryData(
                    { value: candidate },
                    { value: { [operator]: value } }
                )))
            } else if (operator === '$exists') {
                // Existing roots may predate presence indexes. Until an index
                // format marker and rebuild path exists, verify against all IDs.
                results.push(await all(false))
            } else if (operator === '$regex') {
                const expression = value instanceof RegExp
                    ? new RegExp(value.source, value.flags)
                    : new RegExp(value, condition.$options || '')
                const scalar = await scan(key, 'string', candidate => {
                    expression.lastIndex = 0
                    return expression.test(candidate)
                })
                const arrays = await scanArrays(key, candidate => queryData(
                    { value: candidate },
                    { value: { $regex: value, ...(condition.$options ? { $options: condition.$options } : {}) } }
                ))
                results.push({ ids: union(scalar.ids, arrays.ids), exact: scalar.exact && arrays.exact })
            } else if (operator === '$mod' && Array.isArray(value) && value.length === 2 && value[0] !== 0) {
                const scalar = await scan(key, 'number', candidate => candidate % value[0] === value[1])
                const arrays = await scanArrays(key, candidate => queryData(
                    { value: candidate },
                    { value: { $mod: value } }
                ))
                results.push({ ids: union(scalar.ids, arrays.ids), exact: scalar.exact && arrays.exact })
            } else if (operator === '$type' && value === 'array') {
                results.push(await scanArrays(key))
            } else if (operator === '$type' && ['string', 'number', 'boolean', 'null', 'bool', 'int', 'long', 'double', 'decimal'].includes(value)) {
                const type = value === 'bool' ? 'boolean' : ['int', 'long', 'double', 'decimal'].includes(value) ? 'number' : value
                results.push(await scan(key, type, () => true))
            } else {
                results.push(await all(false))
            }
        }
        return combineAnd(results)
    }

    const compileRaw = async expression => {
        if (expression === undefined || expression === null) return all(true)
        if (Array.isArray(expression)) return compileAnd(expression)
        if (typeof expression !== 'object') return empty(true)
        const clauses = expandAnd(expression)
        if (clauses.length > 1) return compileAnd(clauses)

        const children = []
        for (const [key, value] of Object.entries(expression)) {
            if (key === '$and') {
                if (!Array.isArray(value)) return empty(true)
                children.push(await compileAnd(value))
            } else if (key === '$or') {
                if (!Array.isArray(value)) return empty(true)
                const branches = []
                for (const clause of value) branches.push(await compileRaw(clause))
                children.push(branches.reduce((result, next) => ({
                    ids: union(result.ids, next.ids),
                    exact: result.exact && next.exact
                }), { ids: new Set(), exact: true }))
            } else if (key === '$nor') {
                if (!Array.isArray(value)) return empty(true)
                const branches = []
                for (const clause of value) branches.push(await compileRaw(clause))
                const match = branches.reduce((result, next) => ({
                    ids: union(result.ids, next.ids),
                    exact: result.exact && next.exact
                }), { ids: new Set(), exact: true })
                children.push(match.exact
                    ? { ids: new Set([...await allIds()].filter(id => !match.ids.has(id))), exact: true }
                    : await all(false))
            } else if (key === '$where' || key.startsWith('$')) {
                children.push(await all(false))
            } else {
                children.push(await compileField(key, value))
            }
        }
        return combineAnd(children)
    }

    const expandAnd = expression => {
        if (Array.isArray(expression)) return expression
        if (!expression || typeof expression !== 'object') return [expression]
        const clauses = []
        for (const [key, value] of Object.entries(expression)) {
            if (key === '$and' && Array.isArray(value)) clauses.push(...value)
            else clauses.push({ [key]: value })
        }
        return clauses
    }

    return compileAnd(expandAnd(query))
}
