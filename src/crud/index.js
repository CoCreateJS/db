import { updateArtifact } from '../artifact.js'
import { queryTree } from '../tree/query.js'

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

export async function crud({ db, scopes, persistence }, request) {
    const response = { ...request }
    try {
        const [scope, action] = String(request.method ?? '').split('.')
        if (!scope || !methods.has(action)) throw Error(`Unsupported CRUD method: ${request.method}`)
        const inputs = inputArray(request[scope], scope)
        const filter = request.filter?.isFilter === false ? undefined : request.filter
        if (action === 'create' && filter) throw Error('Filters are not supported for create')
        if (filter && (filter.sort?.length || filter.search !== undefined))
            throw Error('sort/search not implemented')

        const canCreateParents = action === 'create' || action === 'update' && request.upsert
        const resolved = scopes.resolve(request, scope, { createMissing: canCreateParents })
        const output = response[scope] = []
        if (resolved.missing) return { ...response, success: true }
        for (const artifact of resolved.created) await persistence.set(artifact.uuid, artifact)
        const parent = resolved.parent
        const select = (query = {}, limit = Infinity) => scopes.select(parent, scope, query, limit)

        async function create(input) {
            if (scope !== 'object' && (typeof input.name !== 'string' || !input.name))
                throw Error(`${scope}.create requires name`)
            const ref = identity(scope, input)
            if (ref && select(ref, 1).length) throw Error('duplicate identity')
            if (scope !== 'object' && input.name && select({ name: input.name }, 1).length)
                throw Error('duplicate name')
            if (scope === 'object' && input._id && select({ _id: input._id }, 1).length)
                throw Error('duplicate identity')
            const artifact = scopes.create(input, parent, scope)
            await persistence.set(artifact.uuid, artifact)
            return artifact
        }

        if (action === 'create') {
            for (const input of inputs) output.push(await create(input))
            return { ...response, success: true }
        }

        const targets = new Map()
        for (const input of inputs) {
            const ref = identity(scope, input)
            if (!ref) continue
            for (const artifact of select(ref, Infinity)) targets.set(artifact, input)
        }

        if (filter) {
            const start = filter.startingIndex ?? filter.index ?? 0
            const limit = filter.limit ?? 50
            if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(limit) || limit < 0)
                throw Error('invalid pagination')
            const matches = select(filter.query ?? {}, limit === 0 ? Infinity : start + limit).slice(start)
            for (const artifact of matches)
                if (!targets.has(artifact)) targets.set(artifact, inputs[0] ?? {})
        }

        if (action === 'update') {
            if (!targets.size && request.upsert && inputs.length === 1) output.push(await create(inputs[0]))
            else {
                if (!filter && !inputs.some(input => identity(scope, input)))
                    throw Error(`${scope}.update requires identity or filter`)
                if (!targets.size && !filter) throw Error(`${scope} not found`)
                for (const [artifact, input] of targets) {
                    const { uuid, _id, $update, ...patch } = input
                    updateArtifact(artifact, { ...patch, ...request.$update, ...$update })
                    await persistence.set(artifact.uuid, artifact)
                    output.push(artifact)
                }
            }
        } else if (action === 'read') {
            output.push(...targets.keys())
        } else {
            for (const artifact of targets.keys()) {
                scopes.remove(artifact)
                await persistence.delete(artifact.uuid)
                output.push(artifact)
            }
        }
        return { ...response, success: true }
    } catch (error) {
        return { ...response, success: false, error: [error.message] }
    }
}
