import DB, { Tree } from '@cocreate/db'

// DB is initialized only through DB.init().
export async function example(server = {}, options = {}) {
    const db = await DB.init(server, options)

    // The complete DB interface is { config, organizations, send }.
    const tree = await db.organizations.get('example')
    const config = db.config // Defaults used to compose organization Trees.
    const organizationConfig = tree.config // This Tree's current configuration.

    const payload = {
        organization_id: 'example',
        storage: 'main',
        database: 'app',
        array: 'contacts',
        method: 'object.create',
        object: { name: 'Example' }
    }
    const response = await db.send(payload)
    const uuid = response.object[0].uuid

    // Tree owns the execution path and can execute the same envelope directly.
    await tree.execute({ ...payload, method: 'object.read', object: { uuid } })
    await tree.leaves.has(uuid)
    const leaf = await tree.leaves.get(uuid)

    tree.roots.get()
    tree.roots.get('storage.database')
    // Update a root definition when needed:
    // await tree.roots.execute({ operation: 'set', path, data: definition })

    // Replaceable stateless functions. Neither requires constructing an instance.
    const execute = tree.execute
    tree.execute = async function(data) {
        return await execute.call(this, data)
    }
    const planner = tree.planner
    tree.planner = (branch, query) => planner(branch, query)

    // Resource objects are assigned directly.
    // tree.disk = disk
    // tree.persistence = persistence

    const { size, leafSize, diskFirst, prune } = tree.config
    tree.setDiskFirst(false)
    await tree.prune() // Uses the configured strategy and limit.
    await tree.prune({ strategy: 'lfu', limit: 100 })
    await tree.persist() // Delegates to the attached persistence adapter.

    // A standalone Tree accepts configuration from its composer.
    const temporaryTree = new Tree()
    temporaryTree.organizationId = 'temporary'
    if (options.disk) temporaryTree.disk = options.disk
    if (options.persistence) temporaryTree.persistence = options.persistence
    await temporaryTree.init({ roots: config.roots, size, leafSize, prune })
    await temporaryTree.close()

    // Closing an organization Tree completes its work and removes it from DB's map.
    await tree.close()
    return { db, leaf, organizationConfig, diskFirst }
}
