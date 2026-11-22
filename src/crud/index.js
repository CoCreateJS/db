import { update } from './update.js'

export const persistenceChanges = Symbol.for('cocreate.db.persistenceChanges')
const methods = new Set(['create', 'read', 'update', 'delete'])
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function inputArray(value, root) {
    if (value === undefined) return []
    const values = Array.isArray(value) ? value : [value]
    if (values.some(item => !isRecord(item))) throw new TypeError(`${root} must contain objects`)
    return values
}

function identity(root, value) {
    if (value.uuid) return { uuid: value.uuid }
    return root === 'object' ? value._id ? { _id: value._id } : undefined : value.name ? { name: value.name } : undefined
}

export async function crud({ db, roots }, request) {
    const response = { ...request }
    delete response.awareness
    const awareness = new Set()
    const changed = new Set()
    function result(success, error) {
        const output = { ...response, awareness: [...awareness], success, ...(error ? { error: [error.message] } : {}) }
        Object.defineProperty(output, persistenceChanges, { value: changed })
        return output
    }
    try {
        const [root, action] = String(request.method ?? '').split('.')
        if (!root || !methods.has(action)) throw Error(`Unsupported CRUD method: ${request.method}`)
        const replay = action === 'update' && Array.isArray(request.$update)
        const inputs = inputArray(replay ? request.$update : request[root], root)
        if (replay && (request.filter || request.upsert || inputs.some(item => !item.uuid))) throw Error('replay requires explicit UUID targets without filter or upsert')
        const filter = request.filter?.isFilter === false ? undefined : request.filter
        if (action === 'create' && filter) throw Error('Filters are not supported for create')
        if (filter && (filter.sort?.length || filter.search !== undefined)) throw Error('sort/search not implemented')
        const output = response[root] = []
        function addResult(leaf, includeParent = false) {
            output.push(leaf)
            if (typeof leaf?.uuid === 'string' && leaf.uuid) awareness.add(leaf.uuid)
            if (includeParent && typeof leaf?.parent === 'string') awareness.add(leaf.parent)
        }
        const canCreateParents = action === 'create' || action === 'update' && request.upsert
        let resolved
        function resolve() {
            if (!resolved) {
                resolved = roots.resolve(request, root, { createMissing: canCreateParents })
                for (const leaf of resolved.created) changed.add(leaf)
            }
            return resolved
        }
        const select = (query = {}, limit = Infinity) => resolved.missing ? [] : roots.select(resolved.parent, root, query, limit)

        function create(input) {
            if (root !== 'object' && (typeof input.name !== 'string' || !input.name)) throw Error(`${root}.create requires name`)
            if (input.uuid && db.leaves.has(input.uuid)) throw Error('duplicate identity')
            resolve()
            if (resolved.missing) return
            if (root !== 'object' && input.name && select({ name: input.name }, 1).length) throw Error('duplicate name')
            if (root === 'object' && input._id && roots.hasIdentity(resolved.parent, input._id)) throw Error('duplicate identity')
            const leaf = roots.create(input, resolved.parent, root)
            if (leaf) changed.add(leaf)
            return leaf
        }

        if (action === 'create') {
            if (!inputs.length) roots.validateTarget(root)
            for (const input of inputs) addResult(create(input), true)
            return result(true)
        }

        const targets = new Map()
        for (const input of inputs) {
            const ref = identity(root, input)
            if (!ref) continue
            if (ref.uuid) {
                const leaf = roots.direct(request, root, ref.uuid)
                if (leaf) targets.set(leaf, input)
            } else {
                resolve()
                for (const leaf of select(ref)) targets.set(leaf, input)
            }
        }

        if (filter) {
            const start = filter.startingIndex ?? filter.index ?? 0
            const limit = filter.limit ?? 50
            if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(limit) || limit < 0) throw Error('invalid pagination')
            const scope = resolve()
            if (!scope.missing && typeof scope.parent?.uuid === 'string') awareness.add(scope.parent.uuid)
            const matches = select(filter.query ?? {}, limit === 0 ? Infinity : start + limit).slice(start)
            for (const leaf of matches) if (!targets.has(leaf)) targets.set(leaf, inputs[0] ?? {})
        }

        if (!resolved && !targets.size) roots.validateTarget(root)
        if (action === 'update') {
            delete response.updated
            const updates = response.$update = []
            if (replay && targets.size !== inputs.length) throw Error('missing or duplicate replay target')
            if (!targets.size && request.upsert && inputs.length === 1) addResult(create(inputs[0]), true)
            else {
                if (!filter && !replay && !inputs.some(input => identity(root, input))) throw Error(`${root}.update requires identity or filter`)
                if (!targets.size && !filter && (!replay || inputs.length)) throw Error(`${root} not found`)
                for (const [leaf, input] of targets) {
                    const result = update(leaf, input, replay ? undefined : request.$update)
                    if (result.mutation) { updates.push(result.mutation); changed.add(leaf) }
                    addResult(result.object, true)
                }
            }
        } else if (action === 'read') {
            for (const leaf of targets.keys()) addResult(leaf)
        }
        else {
            for (const leaf of targets.keys()) {
                await leaf.delete()
                changed.add(leaf)
                addResult(leaf, true)
            }
        }
        return result(true)
    } catch (error) {
        return result(false, error)
    }
}
