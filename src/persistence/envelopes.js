import { normalizeQuery } from '../query.js'

// Copy request/view containers only; database-owned values remain live internally.
export function localReadRequest(request) {
    const filter = value => value && ({ ...value,
        ...(value.storages ? { storages: value.storages.map(item => ({ ...item })) } : {}) })
    const selector = value => value && typeof value === 'object'
        ? { ...value, ...(value.filter ? { filter: filter(value.filter) } : {}) } : value
    return { ...request,
        ...(request.filter ? { filter: filter(request.filter) } : {}),
        ...(request.object ? { object: Array.isArray(request.object) ? request.object.map(selector) : selector(request.object) } : {}) }
}

export function persistenceReadRequest(request) {
    const result = localReadRequest(request)
    const selectors = Array.isArray(request.object) ? request.object : [request.object]
    const explicitQuery = request.filter?.query ?? request.object?.filter?.query
    const query = explicitQuery !== undefined ? normalizeQuery({ ...request, filter: { query: explicitQuery } }) : (selectors.length > 1
        ? { $or: selectors.map(object => normalizeQuery({ ...request, object })) }
        : normalizeQuery(request))
    result.filter ??= result.object?.filter ?? {}
    result.filter.query = query
    // No document values/updated metadata go to the legacy adapter: a read must
    // never enter its old source-object synchronization/write path.
    result.object = []
    const complete = filter => {
        if (!filter) return
        // Hydrate complete documents and enough of the ordered prefix for the
        // original local read to apply its own offset and projection once.
        const offset = filter.startingIndex ?? filter.index ?? 0
        if (filter.limit) filter.limit += offset
        delete filter.key
        delete filter.storages
        delete filter.count
        filter.index = 0
        filter.startingIndex = 0
    }
    complete(result.filter)
    return result
}
