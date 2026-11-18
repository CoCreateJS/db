const uuidPattern = /^[a-f0-9]{32}$/i

export function normalizeEntities(value, scope) {
    if (value === undefined) return []
    const entities = Array.isArray(value) ? value : [value]
    for (const entity of entities) {
        if (!entity || typeof entity !== 'object' || Array.isArray(entity))
            throw new TypeError(`${scope} must be an object or an array of objects`)
    }
    return entities
}

export function entityUuid(entity, scope) {
    if (entity?.uuid === undefined) return undefined
    if (typeof entity.uuid !== 'string' || !uuidPattern.test(entity.uuid))
        throw new TypeError(`${scope}.uuid must be a 32-character hexadecimal UUID`)
    return entity.uuid.toLowerCase()
}

export function entityId(entity, property, scope) {
    if (entity?.[property] === undefined) return undefined
    if (typeof entity[property] !== 'string' || !entity[property].length)
        throw new TypeError(`${scope}.${property} must be a non-empty string`)
    return entity[property]
}

export function hasExplicitFilter(request) {
    return request.filter !== undefined && request.filter !== null && request.filter.isFilter !== false
}

export function filterLimit(filter) {
    const limit = filter?.limit
    if (limit === undefined) return 50
    if (!Number.isSafeInteger(limit) || limit < 0)
        throw new TypeError('filter.limit must be a non-negative integer')
    return limit
}
