import { applyUpdate, queryData } from '@cocreate/utils'
import { updateLeaf } from './leaf.js'
import { treeContexts } from './internal.js'

const methods = new Set(['create', 'read', 'update', 'delete'])
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const TREE_STOP = Symbol.for('cocreate.db.tree.stop')

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
    const response = { ...request }
    delete response.awareness
    const awareness = new Set()
    const [root, operation] = String(request.method ?? '').split('.')
    const output = []
    if (root) response[root] = output
    const result = (success, error) => ({
        ...response,
        awareness: [...awareness],
        success,
        ...(error ? { error: [error.message] } : {})
    })

    try {
        if (!root || !methods.has(operation)) throw new Error(`Unsupported CRUD method: ${request.method}`)
        const values = inputs(request[root], root)
        const filter = request.filter?.isFilter === false ? undefined : request.filter
        if (operation === 'create' && filter) throw new Error('Filters are not supported for create')
        if (filter && (filter.sort?.length || filter.search !== undefined)) throw new Error('sort/search not implemented')

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
                ? await tree.createLeaves(root, values, request, { identityChecked: true })
                : []
            for (const leaf of leaves) {
                output.push(leaf)
                addAwareness(leaf, awareness, true)
            }
            if (!values.length) await tree.getPrimaryBranch(request)
            return result(true)
        }

        if (!filter && !values.length) {
            if (operation === 'update' && !request.upsert) throw new Error(`${root}.update requires identity or filter`)
            return result(true)
        }
        const refs = values.map(value => ({ value, ref: identity(root, value) })).filter(item => item.ref)
        const directUuidOnly = refs.length > 0 && refs.every(item => Boolean(item.ref.uuid))
        const scope = directUuidOnly ? undefined : await tree.getPrimaryBranch(request)
        if (scope?.missing) return result(true)
        const filterQuery = filter?.query ?? {}
        const start = filter?.startingIndex ?? filter?.index ?? 0
        const requestedLimit = filter?.limit ?? 50
        if (filter && (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(requestedLimit) || requestedLimit < 0)) throw new Error('invalid pagination')
        const limit = filter ? (requestedLimit === 0 ? Infinity : requestedLimit) : Infinity
        const seen = new Set()
        let matched = 0
        let skipped = 0
        let returned = 0
        let stopped = false
        const operate = async (leaf, input) => {
            if (seen.has(leaf.uuid)) return
            seen.add(leaf.uuid)
            matched++
            if (skipped++ < start) return

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
            if (stopped) return TREE_STOP
        }

        if (refs.length) {
            for (const { ref, value } of refs) {
                const query = ref.query ?? filterQuery
                await find(tree, {
                    root, request, scope, uuid: ref.uuid, query,
                    predicates: [...(ref.query ? [ref.query] : []), ...(filter ? [filterQuery] : [])],
                    visit: leaf => operate(leaf, value),
                    stop: () => stopped
                })
                if (stopped) break
            }
        } else if (filter) {
            await find(tree, {
                root, request, scope, query: filterQuery, visit: leaf => operate(leaf, values[0] ?? {}),
                stop: () => stopped
            })
        }

        if (operation === 'update' && matched === 0 && request.upsert && values.length === 1) {
            const created = await tree.createLeaf(root, values[0], request)
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
    }

}

/** UUID and query plans share this single candidate/match/visit entry point. */
async function find(tree, { root, request, scope, uuid, query = {}, predicates, visit, globalUuid = false, stop = () => false }) {
    const matches = async leaf => {
        if (!globalUuid && (!await tree.matchesRoot(request, root, leaf) ||
            scope?.parent?.uuid !== undefined && leaf.parent !== scope.parent.uuid)) return
        for (const predicate of predicates ?? [query]) if (!queryData(leaf, predicate)) return
        const result = await visit(leaf)
        return { matched: true, stop: result === TREE_STOP }
    }

    if (uuid) {
        const leaf = await tree.leaves.get(uuid)
        if (!leaf) return 0
        return (await matches(leaf))?.matched ? 1 : 0
    }

    if (!scope || scope.missing) return 0
    const plan = await tree.planner(scope, query)
    let visited = 0
    for await (const leaf of tree.getLeaves(plan)) {
        visited++
        const result = await matches(leaf)
        if (result?.stop || stop()) break
    }
    return visited
}
