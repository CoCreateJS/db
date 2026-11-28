const encodeUuid = value => typeof Buffer === 'function'
    ? Buffer.from(value).toString('hex')
    : Array.from(new TextEncoder().encode(value), byte => byte.toString(16).padStart(2, '0')).join('')

// DB owns the file layout; the attached Disk resource owns platform I/O.
export function storageRequest(context, { operation, kind, uuid, data }) {
    const organization = context.organizationId
    const prefix = organization === undefined ? '' : `${encodeURIComponent(organization).replaceAll('.', '%2E')}/`
    const path = kind === 'roots' ? 'config.json'
        : kind === 'config' ? `trees/${uuid ?? context.uuid}/config.json`
        : kind === 'branch' ? `branches/${uuid}.json`
        : kind === 'leaf' ? `leaves/${encodeUuid(uuid)}.json` : undefined
    if (!path) throw new Error(`Unsupported disk kind: ${kind}`)
    return { operation, kind, path: prefix + path, uuid: uuid ?? context.uuid ?? organization,
        primary: context.uuid ?? organization ?? 'roots', data,
        ...(organization === undefined ? {} : { organization_id: organization }) }
}

export async function executeDisk(context, request) {
    try { return await context.disk.execute(storageRequest(context, request)) }
    catch (error) {
        if (request.operation === 'read' && (error.code === 'ENOENT' || error.name === 'NotFoundError')) return undefined
        throw error
    }
}

export const emptyStorage = Object.freeze({
    queue: Object.freeze(Object.create(null)),
    async execute(request) {
        if (request.operation === 'read') return undefined
        if (request.operation === 'has') return false
        if (request.operation === 'list') return []
        return request
    }
})
