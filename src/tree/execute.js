import { applyUpdate, queryData, searchData, sortData } from '@cocreate/utils'
import { updateLeaf } from './leaf.js'
import { treeContexts } from './internal.js'

const methods = new Set(['create', 'read', 'update', 'delete'])
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)

async function update(object, input, global = {}) {
    const { uuid, _id, $update, ...fields } = input
    const patch = { ...fields, ...global, ...$update }
    const result = await applyUpdate(object, patch, { apply: updateLeaf })
    if (result.mutation) Object.assign(result.mutation, {
        uuid: object.uuid,
        ...(object._id !== undefined ? { _id: object._id } : {})
    })
    return result
}

function inputs(value, root) {
    if (value === undefined) return []
    const result = Array.isArray(value) ? value : [value]
    if (result.some(item => !isRecord(item))) throw new TypeError(`${root} must contain objects`)
    return result
}

function identity(root, value) {
    if (typeof value.uuid === 'string' && value.uuid) return { uuid: value.uuid }
    if (root === 'object' && value._id !== undefined) return { query: { _id: value._id } }
    if (root !== 'object' && typeof value.name === 'string' && value.name) return { query: { name: value.name } }
}

function addAwareness(leaf, awareness, parent = false) {
    awareness.add(leaf.uuid)
    if (parent && leaf.parent !== undefined) awareness.add(leaf.parent)
}

/** Default stateless execution path, called as tree.execute(payload). */
export default async function execute(request = {}) {
    const tree = treeContexts.get(this)
    let pagination
    const response = { ...request }
    delete response.awareness
    const awareness = new Set()
    const [root, operation] = String(request.method ?? '').split('.')
    const activity = tree.operation(request, root)
    const output = []
    if (root) response[root] = output
    const result = (success, error) => ({
        ...(pagination ? { ...response, filter: { ...request.filter, startingIndex: pagination.start, index: pagination.start + output.length } } : response),
        awareness: [...awareness],
        success,
        ...(error ? { error: [error.message] } : {})
    })

    try {
        if (!root || !methods.has(operation)) throw new Error(`Unsupported CRUD method: ${request.method}`)
        const values = inputs(request[root], root)
        const filter = request.filter?.isFilter === false ? undefined : request.filter
        if (operation === 'create' && filter) throw new Error('Filters are not supported for create')

        if (operation === 'create') {
            const supplied = new Set()
            const suppliedUuids = []
            for (const value of values) {
                if (value.uuid) {
                    if (supplied.has(value.uuid)) throw new Error('duplicate identity')
                    supplied.add(value.uuid)
                    suppliedUuids.push(value.uuid)
                }
            }
            if (suppliedUuids.length) {
                const exists = await Promise.all(suppliedUuids.map(uuid => tree.leaves.has(uuid)))
                if (exists.some(Boolean)) throw new Error('duplicate identity')
            }
            const leaves = values.length
                ? await tree.createLeaves(root, values, { identityChecked: true })
                : []
            for (const leaf of leaves) {
                output.push(leaf)
                addAwareness(leaf, awareness, true)
            }
            if (!values.length) await tree.getPrimaryBranch(request, activity)
            return result(true)
        }

        if (!filter && !values.length) {
            if (operation === 'update' && !request.upsert) throw new Error(`${root}.update requires identity or filter`)
            return result(true)
        }
        const refs = values.map(value => ({ value, ref: identity(root, value) })).filter(item => item.ref)
        const directUuidOnly = refs.length > 0 && refs.every(item => Boolean(item.ref.uuid))
        const scope = directUuidOnly ? undefined : await tree.getPrimaryBranch(request, activity)
        if (scope?.missing) return result(true)
        const filterQuery = filter?.query ?? {}
        const start = filter?.startingIndex ?? filter?.index ?? 0
        const requestedLimit = filter?.limit ?? 50
        if (filter && (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(requestedLimit) || requestedLimit < 0)) throw new Error('invalid pagination')
        const limit = filter ? (requestedLimit === 0 ? Infinity : requestedLimit) : Infinity
        if (filter) pagination = { start }
        const seen = new Set()
        let matched = 0
        let skipped = 0
        let returned = 0
        let stopped = false
        const operate = async (leaf, input, paginated = false) => {
            if (seen.has(leaf.uuid)) return
            seen.add(leaf.uuid)
            matched++
            if (!paginated && skipped++ < start) return

            switch (operation) {
                case 'read':
                    output.push(leaf)
                    break
                case 'update': {
                    const updated = await update(leaf, input, request.$update)
                    if (updated.mutation) (response.$update ??= []).push(updated.mutation)
                    output.push(updated.object)
                    break
                }
                case 'delete': {
                    await tree.removeLeaf(leaf.uuid)
                    output.push(leaf)
                    break
                }
            }
            addAwareness(leaf, awareness, true)
            returned++
            if (returned >= limit) stopped = true
        }

        if (refs.length && filter?.sort?.length) {
            const candidates = new Map()
            for (const { ref, value } of refs) {
                await find(tree, {
                    root, request, scope, uuid: ref.uuid, query: filterQuery, activity,
                    predicates: [...(ref.query ? [ref.query] : []), filterQuery],
                    filter: { ...filter, index: 0, startingIndex: 0, limit: 0, sort: [] },
                    visit: leaf => { if (!candidates.has(leaf.uuid)) candidates.set(leaf.uuid, { leaf, input: value }) }
                })
            }
            const leaves = sortData([...candidates.values()].map(item => item.leaf), [...filter.sort, { key: 'uuid', direction: 'asc' }])
            for (const leaf of leaves) { await operate(leaf, candidates.get(leaf.uuid).input); if (stopped) break }
        } else if (refs.length) {
            for (const { ref, value } of refs) {
                await find(tree, {
                    root, request, scope, uuid: ref.uuid, query: filterQuery, activity,
                    predicates: [...(ref.query ? [ref.query] : []), ...(filter ? [filterQuery] : [])],
                    filter: { ...filter, index: 0, startingIndex: 0, limit: 0 },
                    visit: leaf => operate(leaf, value), stop: () => stopped
                })
                if (stopped) break
            }
        } else if (filter) {
            const found = await find(tree, {
                root, request, scope, query: filterQuery, filter, activity,
                visit: leaf => operate(leaf, values[0] ?? {}, true), stop: () => stopped
            })
            matched = Math.max(matched, found)
        }

        if (operation === 'update' && matched === 0 && request.upsert && values.length === 1) {
            const created = await tree.createLeaf(root, values[0])
            if (created) {
                output.push(created)
                addAwareness(created, awareness, true)
            }
        } else if (operation === 'update' && matched === 0 && !filter) {
            throw new Error(refs.length ? `${root} not found` : `${root}.update requires identity or filter`)
        }
        return result(true)
    } catch (error) {
        return result(false, error)
    } finally { await activity.release() }

}

/** UUID requests stay direct; planned queries arrive fully selected and paginated. */
async function find(tree, { root, request, scope, uuid, query = {}, predicates, filter = { limit: 0 }, activity, visit, stop = () => false }) {
    if (uuid) {
        const leaf = await tree.leaves.get(uuid, activity)
        if (!leaf || !await tree.matchesRoot(request, root, leaf, activity)) return 0
        for (const predicate of predicates ?? [query]) if (!queryData(leaf, predicate)) return 0
        if (!searchData(leaf, filter.search)) return 0
        await visit(leaf)
        return 1
    }
    if (!scope || scope.missing) return 0
    const predicate = predicates?.length ? { $and: predicates } : query
    const plan = await tree.planner(scope, predicate, filter)
    plan.mutating = !request.method.endsWith('.read')
    for await (const leaf of tree.getLeaves(plan, activity)) {
        await visit(leaf)
        if (stop()) break
    }
    return plan.matched ?? 0
}
