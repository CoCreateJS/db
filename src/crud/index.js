import { update } from './update.js'

const methods = new Set(['create', 'read', 'update', 'delete'])
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function inputArray(value, scope) {
    if (value === undefined) return []
    const values = Array.isArray(value) ? value : [value]
    if (values.some(item => !isRecord(item))) throw new TypeError(`${scope} must contain objects`)
    return values
}

function identity(scope, value) {
    if (value.uuid) return { uuid: value.uuid }
    return scope === 'object' ? value._id ? { _id: value._id } : undefined : value.name ? { name: value.name } : undefined
}

export async function crud({ db, scopes }, request) {
    const response = { ...request }
    try {
        const [scope, action] = String(request.method ?? '').split('.')
        if (!scope || !methods.has(action)) throw Error(`Unsupported CRUD method: ${request.method}`)
        const replay = action === 'update' && Array.isArray(request.$update)
        const inputs = inputArray(replay ? request.$update : request[scope], scope)
        if (replay && (request.filter || request.upsert || inputs.some(item => !item.uuid))) throw Error('replay requires explicit UUID targets without filter or upsert')
        const filter = request.filter?.isFilter === false ? undefined : request.filter
        if (action === 'create' && filter) throw Error('Filters are not supported for create')
        if (filter && (filter.sort?.length || filter.search !== undefined)) throw Error('sort/search not implemented')
        const output = response[scope] = []
        const canCreateParents = action === 'create' || action === 'update' && request.upsert
        let resolved
        function resolve() {
            if (!resolved) {
                resolved = scopes.resolve(request, scope, { createMissing: canCreateParents })
            }
            return resolved
        }
        const select = (query = {}, limit = Infinity) => resolved.missing ? [] : scopes.select(resolved.parent, scope, query, limit)

        function create(input) {
            if (scope !== 'object' && (typeof input.name !== 'string' || !input.name)) throw Error(`${scope}.create requires name`)
            if (input.uuid && db.artifacts.has(input.uuid)) throw Error('duplicate identity')
            resolve()
            if (resolved.missing) return
            if (scope !== 'object' && input.name && select({ name: input.name }, 1).length) throw Error('duplicate name')
            if (scope === 'object' && input._id && select({ _id: input._id }, 1).length) throw Error('duplicate identity')
            const artifact = scopes.create(input, resolved.parent, scope)
            return artifact
        }

        if (action === 'create') {
            if (!inputs.length) scopes.validateTarget(scope)
            for (const input of inputs) output.push(create(input))
            return { ...response, success: true }
        }

        const targets = new Map()
        for (const input of inputs) {
            const ref = identity(scope, input)
            if (!ref) continue
            if (ref.uuid) {
                const artifact = scopes.direct(request, scope, ref.uuid)
                if (artifact) targets.set(artifact, input)
            } else {
                resolve()
                for (const artifact of select(ref)) targets.set(artifact, input)
            }
        }

        if (filter) {
            const start = filter.startingIndex ?? filter.index ?? 0
            const limit = filter.limit ?? 50
            if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(limit) || limit < 0) throw Error('invalid pagination')
            resolve()
            const matches = select(filter.query ?? {}, limit === 0 ? Infinity : start + limit).slice(start)
            for (const artifact of matches) if (!targets.has(artifact)) targets.set(artifact, inputs[0] ?? {})
        }

        if (!resolved && !targets.size) scopes.validateTarget(scope)
        if (action === 'update') {
            delete response.updated
            const updates = response.$update = []
            if (replay && targets.size !== inputs.length) throw Error('missing or duplicate replay target')
            if (!targets.size && request.upsert && inputs.length === 1) output.push(create(inputs[0]))
            else {
                if (!filter && !replay && !inputs.some(input => identity(scope, input))) throw Error(`${scope}.update requires identity or filter`)
                if (!targets.size && !filter && (!replay || inputs.length)) throw Error(`${scope} not found`)
                for (const [artifact, input] of targets) {
                    const result = update(artifact, input, replay ? undefined : request.$update)
                    if (result.mutation) updates.push(result.mutation)
                    output.push(result.object)
                }
            }
        } else if (action === 'read') output.push(...targets.keys())
        else {
            for (const artifact of targets.keys()) {
                scopes.remove(artifact)
                output.push(artifact)
            }
        }
        return { ...response, success: true }
    } catch (error) {
        return { ...response, success: false, error: [error.message] }
    }
}
