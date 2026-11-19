import { uuid } from '@cocreate/utils'

const organizations = new Map()

function state(organization_id) {
    if (!organizations.has(organization_id)) {
        const root = { version: '1.0.0', root: uuid().replaceAll('-', '') }
        organizations.set(organization_id, { root, data: new Map() })
    }
    return organizations.get(organization_id)
}

/** Return the live organization root, creating an empty root when first used. */
export function getOrganization(organization_id, initialRoot) {
    if (typeof organization_id !== 'string' || !organization_id)
        throw new TypeError('organization_id is required')
    const current = state(organization_id)
    if (initialRoot && current.root !== initialRoot) current.root = initialRoot
    return current.root
}

/** Install a root supplied by persistence or another bootstrap authority. */
export function setOrganization(organization_id, root) {
    if (typeof organization_id !== 'string' || !organization_id)
        throw new TypeError('organization_id is required')
    if (!root || typeof root !== 'object' || Array.isArray(root))
        throw new TypeError('Organization root must be an object')
    state(organization_id).root = root
    return root
}

/** Read or install a decoded artifact by its opaque UUID within one organization. */
export function getArtifact(organization_id, artifactId) {
    return state(validOrganization(organization_id)).data.get(artifactId)
}

/** Return the organization's shared UUID-to-artifact Map. */
export function getArtifactMap(organization_id) {
    return state(validOrganization(organization_id)).data
}

export function setArtifact(organization_id, artifactId, value) {
    if (!/^[a-f0-9]{32}$/i.test(artifactId)) throw new TypeError('Artifact ID must be a UUID')
    state(validOrganization(organization_id)).data.set(artifactId, value)
    return value
}

export function deleteArtifact(organization_id, artifactId) {
    return state(validOrganization(organization_id)).data.delete(artifactId)
}

export function hasArtifact(organization_id, artifactId) {
    return state(validOrganization(organization_id)).data.has(artifactId)
}

function validOrganization(organization_id) {
    if (typeof organization_id !== 'string' || !organization_id)
        throw new TypeError('organization_id is required')
    return organization_id
}

export function deleteOrganization(organization_id) {
    return organizations.delete(organization_id)
}
