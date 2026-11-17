import { getPersistenceDriver } from './driver.js'

/**
 * Resolve a named persistence from an organization's configured API records.
 * Missing or unknown names use the organization's bootstrap persistence.
 */
export async function getPersistence({ organization, organizationId, name, bootstrapPersistence } = {}) {
    if (!organizationId)
        throw new Error('Missing an organization_id while resolving persistence.')

    const bootstrap = [organization?.bootstrapPersistence, organization?.persistence,
        organization?.bootstrapStorage, organization?.storage].find(value =>
        value && typeof value === 'object' && !Array.isArray(value)) || bootstrapPersistence
    if (!bootstrap) return
    if (typeof bootstrap !== 'object' || Array.isArray(bootstrap) || !bootstrap.name || !bootstrap.provider)
        throw new Error(`Bootstrap persistence is not configured with name and provider for organization "${organizationId}".`)

    if (!name || name === bootstrap.name) return bootstrap

    const driver = await getPersistenceDriver(bootstrap.provider)
    const response = await driver.send({
        method: 'object.read',
        organization_id: organizationId,
        database: organizationId,
        array: 'apis',
        object: [],
        filter: { query: { type: 'persistence', enabled: true, name }, limit: 1 },
        persistenceConfig: bootstrap
    })

    const persistence = response?.object?.[0]
    return persistence?.name && persistence?.provider ? persistence : bootstrap
}

/** Send a CoCreate envelope to its selected provider, falling back to bootstrap. */
export async function sendPersistence(data, { organization, organizationId = data?.organization_id, bootstrapPersistence } = {}) {
    const persistence = await getPersistence({
        organization,
        organizationId,
        name: data?.persistence,
        bootstrapPersistence
    })
    if (!persistence) throw new Error(`No persistence is configured for organization "${organizationId}".`)

    const driver = await getPersistenceDriver(persistence.provider)
    return driver.send({ ...data, persistenceConfig: persistence })
}

export { getPersistenceDriver, registerPersistenceDriver, persistenceDrivers } from './driver.js'
