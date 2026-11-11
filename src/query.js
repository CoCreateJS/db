const typeOf = value => value === null ? 'null' :
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
export async function queryIndexCandidates(index, database, array, query) {
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
        const root = await index.get(database, array, key)
        if (!root.indexes[type]) return empty(true)
        const ids = new Set()
        for await (const entry of index.scan(database, array, key, { type, ...range }))
            if (predicate(entry.value)) ids.add(entry.objectId)
        return { ids, exact: true }
    }

    const equality = async (key, value) => {
        const type = typeOf(value)
        if (!type) return all(false)
        return scan(key, type, candidate => Object.is(candidate, value), { lower: value, upper: value })
    }

    const range = async (key, operator, value) => {
        const root = await index.get(database, array, key)
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
        for (const type of Object.keys(root.indexes || {}))
            for await (const entry of index.scan(database, array, key, { type }))
                if (operators[operator](entry.value, value)) matches.add(entry.objectId)

        return { ids: matches, exact: true }
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

    const compileField = async (key, condition) => {
        if (condition === null || condition === undefined || ['string', 'number', 'boolean'].includes(typeof condition))
            return equality(key, condition)
        if (Array.isArray(condition)) return all(false)
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
                for (const choice of choices) matches.push(await equality(key, choice))
                const match = matches.reduce((result, next) => ({
                    ids: union(result.ids, next.ids),
                    exact: result.exact && next.exact
                }), { ids: new Set(), exact: true })
                results.push(operator === '$in'
                    ? match
                    : match.exact
                        ? { ids: new Set([...await allIds()].filter(id => !match.ids.has(id))), exact: true }
                        : await all(false))
            } else if (operator === '$all' && Array.isArray(value) && value.every(item => typeOf(item))) {
                const matches = []
                for (const item of value) matches.push(await equality(key, item))
                const match = await combineAnd(matches)
                results.push({ ...match, exact: false })
            } else if (operator === '$exists') {
                // Existing roots may predate presence indexes. Until an index
                // format marker and rebuild path exists, verify against all IDs.
                results.push(await all(false))
            } else if (operator === '$regex') {
                const expression = value instanceof RegExp
                    ? new RegExp(value.source, value.flags)
                    : new RegExp(value, condition.$options || '')
                results.push(await scan(key, 'string', candidate => {
                    expression.lastIndex = 0
                    return expression.test(candidate)
                }))
            } else if (operator === '$mod' && Array.isArray(value) && value.length === 2 && value[0] !== 0) {
                results.push(await scan(key, 'number', candidate => candidate % value[0] === value[1]))
            } else if (operator === '$type' && ['string', 'number', 'boolean', 'null', 'bool', 'int', 'long', 'double', 'decimal'].includes(value)) {
                const type = value === 'bool' ? 'boolean' : ['int', 'long', 'double', 'decimal'].includes(value) ? 'number' : value
                const candidate = await scan(key, type, () => true)
                results.push({ ...candidate, exact: false })
            } else {
                results.push(await all(false))
            }
        }
        return combineAnd(results)
    }

    const compile = async expression => {
        if (expression === undefined || expression === null) return all(true)
        if (Array.isArray(expression)) {
            const children = []
            for (const child of expression) children.push(await compile(child))
            return combineAnd(children)
        }
        if (typeof expression !== 'object') return empty(true)

        const children = []
        for (const [key, value] of Object.entries(expression)) {
            if (key === '$and') {
                if (!Array.isArray(value)) return empty(true)
                for (const clause of value) children.push(await compile(clause))
            } else if (key === '$or') {
                if (!Array.isArray(value)) return empty(true)
                const branches = []
                for (const clause of value) branches.push(await compile(clause))
                children.push(branches.reduce((result, next) => ({
                    ids: union(result.ids, next.ids),
                    exact: result.exact && next.exact
                }), { ids: new Set(), exact: true }))
            } else if (key === '$nor') {
                if (!Array.isArray(value)) return empty(true)
                const branches = []
                for (const clause of value) branches.push(await compile(clause))
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

    return compile(query)
}
