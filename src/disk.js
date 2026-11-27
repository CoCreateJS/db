const encodeUuid = value => typeof Buffer === 'function'
    ? Buffer.from(value).toString('hex')
    : Array.from(new TextEncoder().encode(value), byte => byte.toString(16).padStart(2, '0')).join('')

// DB owns the file layout; the attached Disk resource owns platform I/O.
export async function executeDisk(context, { operation, kind, uuid, data }) {
    const organization = context.organizationId
    const prefix = organization === undefined ? '' : `${encodeURIComponent(organization).replaceAll('.', '%2E')}/`
    const path = kind === 'roots' ? 'config.json'
        : kind === 'config' ? `trees/${uuid ?? context.uuid}/config.json`
        : kind === 'branch' ? `branches/${uuid}.json`
        : kind === 'leaf' ? `leaves/${encodeUuid(uuid)}.json` : undefined
    if (!path) throw new Error(`Unsupported disk kind: ${kind}`)
    try { return await context.disk.execute({ operation, kind: 'file', path: prefix + path, data }) }
    catch (error) {
        if (operation === 'read' && (error.code === 'ENOENT' || error.name === 'NotFoundError')) return undefined
        throw error
    }
}

export const emptyStorage = Object.freeze({
    async execute(request) {
        if (request.operation === 'read') return undefined
        if (request.operation === 'has') return false
        if (request.operation === 'list') return []
        return request
    }
})
