/** Dispatch CRUD envelopes to the existing index entry operations. */
export default async function index(method, data, target) {
    const entries = Array.isArray(data.index) ? data.index : [data.index ?? {}]
    const results = []
    for (const entry of entries) {
        const { key, value, objectId } = entry
        switch (method) {
            case 'read':
                results.push(await target.read(data.database, data.array, key))
                break
            case 'create':
            case 'update':
                await target[method](data.database, data.array, key, value, objectId, data)
                results.push(entry)
                break
            case 'delete':
                if (await target.delete(data.database, data.array, key, value, objectId, data)) results.push(entry)
                break
            default:
                throw new Error(`Unsupported CRUD method: ${data.method}`)
        }
    }
    data.index = results
    return data
}
