function errorHandler(data) {
    if (!Array.isArray(data.error)) data.error = data.error === undefined ? [] : [data.error]
    // JSON parser messages can expose fragments of credential-bearing files.
    data.error.push('Persistence returned invalid JSON.')
    data.success = false
    return data
}

/** Decode only serialized file values; parsed objects retain their identity. */
function readPersistenceValue(value) {
    const parsed = JSON.parse(value)
    if (parsed && typeof parsed === 'object') parsed.$bytes = Buffer.byteLength(value, 'utf8')
    return parsed
}

/** Normalize transport envelopes separately from their individual file values. */
export function readPersistenceResponse(response, data) {
    try {
        const raw = typeof response === 'string' ? response : undefined
        if (raw !== undefined) response = JSON.parse(raw)
        const values = Array.isArray(response?.persistence) ? response.persistence : undefined
        const objects = Array.isArray(response?.object) ? response.object : undefined
        if (values) for (const item of values)
            if (typeof item?.value === 'string') item.value = readPersistenceValue(item.value)
        if (objects) for (let i = 0; i < objects.length; i++)
            if (typeof objects[i] === 'string') objects[i] = readPersistenceValue(objects[i])
        if (raw !== undefined && !values && !objects && response && typeof response === 'object')
            response.$bytes = Buffer.byteLength(raw, 'utf8')
        return response
    } catch {
        return errorHandler(data)
    }
}
