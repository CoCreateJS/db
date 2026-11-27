import { queryData, searchData, sortData, dotNotationToObject } from '@cocreate/utils'

const path = key => key.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean).join('.')
const scalar = value => value === null || ['string', 'number', 'boolean'].includes(typeof value)
const type = value => value === null ? 'null' : typeof value
const owns = (object, key) => object && typeof object === 'object' && Object.hasOwn(object, key)

// Bounds only narrow types for which the shared predicate cannot match outside
// the range. Other types are evaluated too, preserving Utils coercion semantics.
function ranges(condition, sourceType) {
    const equality = scalar(condition) ? { value: condition } : owns(condition, '$eq') && scalar(condition.$eq) ? { value: condition.$eq } : undefined
    if (equality) return type(equality.value) === sourceType ? [[equality.value, equality.value]] : []
    if (owns(condition, '$in')) {
        const choices = Array.isArray(condition.$in) ? condition.$in : [condition.$in]
        if (choices.every(scalar)) return [...new Set(choices)].filter(value => type(value) === sourceType).map(value => [value, value])
    }
    const lower = [], upper = []
    for (const key of ['$gt', '$gte']) if (owns(condition, key)) lower.push(condition[key])
    for (const key of ['$lt', '$lte']) if (owns(condition, key)) upper.push(condition[key])
    const bounds = [...lower, ...upper]
    if (bounds.length && bounds.every(value => type(value) === sourceType && scalar(value))) {
        const min = lower.reduce((a, b) => a === undefined || b > a ? b : a, undefined)
        const max = upper.reduce((a, b) => a === undefined || b < a ? b : a, undefined)
        return min !== undefined && max !== undefined && min > max ? [] : [[min, max]]
    }
    return [[undefined, undefined]]
}

/** Execute index algebra, ordering and pagination before fetching payloads. */
export default async function* getLeaves(plan, operation) {
    if (plan?.kind !== 'query') throw new TypeError('Tree.getLeaves requires a query plan')
    const ownOperation = !operation
    operation ??= this.operation()
    const roots = plan.fields.filter(field => field.key === 'root' && field.type === 'string')
    if (plan.primary !== undefined) operation.pin(plan.primary)
    else for (const root of roots) operation.pin(root.primary)
    let universe
    const all = async () => {
        if (universe) return universe
        universe = new Set()
        for (const source of roots) {
            const index = this.readIndex(source.primary, source.key, source.type)
            for await (const entry of index.scan(plan.target, plan.target)) universe.add(entry.uuid)
        }
        return universe
    }
    const inScope = async uuid => {
        if (universe) return universe.has(uuid)
        for (const source of roots) {
            const index = this.readIndex(source.primary, source.key, source.type)
            if (await index.lookup(plan.target, uuid)) return true
        }
        return false
    }
    const fieldEntries = async function* (node) {
        const condition = { value: node.condition }
        const missing = queryData({}, condition)
        if (node.key === 'uuid') {
            const equal = typeof node.condition === 'string' ? node.condition : node.condition?.$eq
            if (typeof equal === 'string') { if (queryData({ value: equal }, condition)) yield equal; return }
            for (const uuid of await all()) if (queryData({ value: uuid }, condition)) yield uuid
            return
        }
        const present = missing ? new Set() : undefined
        let previous = Symbol(), accepted = false
        for (const source of node.sources) {
            const index = this.readIndex(source.primary, source.key, source.type)
            for (const [min, max] of missing ? [[undefined, undefined]] : ranges(node.condition, source.type)) {
                for await (const entry of index.scan(min, max)) {
                    present?.add(entry.uuid)
                    if (!Object.is(previous, entry.value)) { previous = entry.value; accepted = queryData({ value: entry.value }, condition) }
                    if (accepted) yield entry.uuid
                }
            }
        }
        if (missing) for (const uuid of await all()) if (!present.has(uuid)) yield uuid
    }.bind(this)
    const field = async node => {
        const ids = new Set()
        for await (const uuid of fieldEntries(node)) ids.add(uuid)
        return { ids, exact: true }
    }
    const evaluate = async node => {
        if (node.kind === 'none') return { ids: new Set(), exact: true }
        if (node.kind === 'all') return { ids: undefined, exact: true }
        if (node.kind === 'residual') return { ids: undefined, exact: false }
        if (node.kind === 'field') return field(node)
        if (node.kind === 'not') {
            const child = await evaluate(node.node)
            if (!child.exact) return { ids: undefined, exact: false }
            return { ids: child.ids === undefined ? new Set() : new Set([...await all()].filter(uuid => !child.ids.has(uuid))), exact: true }
        }
        const intersection = node.kind === 'and'
        let ids = intersection ? undefined : new Set(), exact = true
        const nodes = intersection ? [...node.nodes].sort((a, b) => (a.estimate ?? Infinity) - (b.estimate ?? Infinity)) : node.nodes
        for (const node of nodes) {
            const child = await evaluate(node)
            exact &&= child.exact
            if (intersection) {
                if (child.ids !== undefined) {
                    if (ids === undefined) ids = child.ids
                    else for (const uuid of ids) if (!child.ids.has(uuid)) ids.delete(uuid)
                }
                if (ids?.size === 0) return { ids, exact: true }
            } else {
                if (child.ids === undefined) {
                    if (child.exact) return { ids: undefined, exact: true }
                    ids = undefined
                } else if (ids !== undefined) for (const uuid of child.ids) ids.add(uuid)
            }
        }
        return { ids, exact }
    }
    const covered = node => node.kind !== 'residual' &&
        (node.nodes ? node.nodes.every(covered) : node.node ? covered(node.node) : true)
    const cached = new Map()
    const contains = async (node, uuid) => {
        if (node.kind === 'all') return true
        if (node.kind === 'none') return false
        if (node.kind === 'and') { for (const child of node.nodes) if (!await contains(child, uuid)) return false; return true }
        if (node.kind === 'or') { for (const child of node.nodes) if (await contains(child, uuid)) return true; return false }
        if (node.kind === 'not') return !await contains(node.node, uuid)
        if (node.key === 'uuid') return queryData({ value: uuid }, { value: node.condition })
        const equal = scalar(node.condition) ? [node.condition] : owns(node.condition, '$eq') && scalar(node.condition.$eq) ? [node.condition.$eq]
            : owns(node.condition, '$in') ? (Array.isArray(node.condition.$in) ? node.condition.$in : [node.condition.$in]) : undefined
        if (equal?.every(scalar)) {
            for (const value of equal) for (const source of node.sources) {
                if (source.type !== type(value)) continue
                const entry = await this.readIndex(source.primary, source.key, source.type).lookup(value, uuid)
                if (entry && queryData({ value: entry.value }, { value: node.condition })) return true
            }
            return false
        }
        if (!cached.has(node)) cached.set(node, evaluate(node))
        const selected = await cached.get(node)
        return selected.ids === undefined || selected.ids.has(uuid)
    }
    const stream = async function* (node) {
        if (node.kind === 'none') return
        if (node.kind === 'all') {
            for (const source of roots) for await (const entry of this.readIndex(source.primary, source.key, source.type).scan(plan.target, plan.target)) yield entry.uuid
        } else if (node.kind === 'field') yield* fieldEntries(node)
        else if (node.kind === 'or') { for (const child of node.nodes) yield* stream(child) }
        else if (node.kind === 'not') { for await (const uuid of stream({ kind: 'all' })) if (!await contains(node.node, uuid)) yield uuid }
        else {
            const nodes = [...node.nodes].sort((a, b) => (a.estimate ?? Infinity) - (b.estimate ?? Infinity))
            if (!nodes.length) { yield* stream({ kind: 'all' }); return }
            for await (const uuid of stream(nodes[0])) {
                let matches = true
                for (let i = 1; i < nodes.length; i++) if (!await contains(nodes[i], uuid)) { matches = false; break }
                if (matches) yield uuid
            }
        }
    }.bind(this)
    try {
        const cursor = !plan.mutating && !plan.sort.length && plan.search === undefined && covered(plan.expression) ? stream(plan.expression) : undefined
        const scopeKnown = plan.expression.kind === 'all' || plan.expression.kind === 'not'
        const selected = cursor ? { exact: true } : await evaluate(plan.expression)
        const ids = cursor ? undefined : selected.ids ?? await all()
        if (!cursor && !ids.size) return
        const sortCovered = plan.sort.every(({ key }) => !plan.fields.some(field => path(field.key).startsWith(`${path(key)}.`)))
        const residual = !selected.exact || plan.search !== undefined
        plan.exact = selected.exact
        plan.matched = 0
        if (plan.sort.length && (!sortCovered || residual)) {
            // Unsupported predicates/container sort keys require document values.
            const leaves = []
            for (const uuid of ids) {
                if (!await inScope(uuid)) continue
                const leaf = await this.getLeaf(uuid, operation)
                if (leaf && !this.deleted.has(uuid) && queryData(leaf, plan.query) && searchData(leaf, plan.search)) leaves.push(leaf)
            }
            sortData(leaves, [...plan.sort, { key: 'uuid', direction: 'asc' }])
            plan.matched = leaves.length
            yield* leaves.slice(plan.start, plan.start + plan.limit)
            return
        }
        let ordered = cursor
        if (plan.sort.length) {
            const rows = new Map([...ids].map(uuid => [uuid, { uuid }]))
            for (const { key } of plan.sort) {
                if (key === 'uuid') continue
                for (const source of plan.fields.filter(field => path(field.key) === path(key))) {
                    const index = this.readIndex(source.primary, source.key, source.type)
                    for await (const entry of index.scan()) {
                        const row = rows.get(entry.uuid)
                        if (row) dotNotationToObject({ [key]: entry.value }, row)
                    }
                }
            }
            ordered = sortData([...rows.values()], [...plan.sort, { key: 'uuid', direction: 'asc' }]).map(row => row.uuid)
        } else if (!cursor) ordered = [...ids].sort()
        let returned = 0
        const seen = new Set()
        for await (const uuid of ordered) {
            if (seen.has(uuid)) continue
            seen.add(uuid)
            if (!(cursor && scopeKnown) && !await inScope(uuid)) continue
            // Settled, covered predicates have already been evaluated by indexes.
            // Pending mutations and residual predicates still need current data.
            const pending = this.pendingIndex.has({ uuid, parent: Map.prototype.get.call(this.leaves, uuid)?.parent ?? this.deleted.get(uuid)?.parent ?? plan.primary })
            let leaf
            if (residual || pending) {
                leaf = await this.getLeaf(uuid, operation)
                if (!leaf || this.deleted.has(uuid) || !queryData(leaf, plan.query) || !searchData(leaf, plan.search)) continue
            }
            plan.matched++
            if (plan.matched <= plan.start) continue
            leaf ??= await this.getLeaf(uuid, operation)
            if (!leaf || this.deleted.has(uuid)) continue
            yield leaf
            if (++returned >= plan.limit) break
        }
    } finally { if (ownOperation) await operation.release() }
}
