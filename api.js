import DB, { Tree } from '@cocreate/db'

export async function example(server = {}, options = {}) {
    const db = await DB.init(server, options)
    // DB exposes only config, organizations and send.
    const organization = await db.organizations.get('example')
    organization.roots.get()
    organization.roots.get('storage.database')
    // await organization.roots.execute({ operation: 'set', path, data })

    const payload = {
        organization_id: 'example', storage: 'main', database: 'app', array: 'contacts',
        method: 'object.create', object: { name: 'Example' }
    }
    const response = await db.send(payload)
    const primaryUuid = response.object[0].parent
    const owner = organization.owners.get(primaryUuid)
    const treeConfig = organization.configuration(primaryUuid)
    await organization.execute({ ...payload, method: 'object.read', object: { uuid: response.object[0].uuid } })
    await organization.prune({ uuid: primaryUuid })

    // Actual Trees live in execution processes. A standalone composer can also
    // create its own independent engine and attach its own storage resources.
    const tree = new Tree()
    tree.organizationId = 'temporary'
    if (options.disk) tree.disk = options.disk
    if (options.persistence) tree.persistence = options.persistence
    await tree.init({ uuid: 'temporary-primary', parent: 'temporary-primary', roots: { object: {} }, size: 64, leafSize: 64 })
    const created = await tree.execute({ method: 'object.create', object: { name: 'Temporary' } })
    await tree.leaves.get(created.object[0].uuid)
    await tree.leaves.has(created.object[0].uuid)
    // tree.execute = customExecute
    // tree.planner = customPlanner // (branch, query, filter)
    tree.setDiskFirst(false)
    await tree.persist()
    await tree.close()
    return { db, owner, treeConfig }
}
