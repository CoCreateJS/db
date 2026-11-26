import {
    createDB,
    init,
    Tree,
    CRUD,
    createCRUD,
    QueryPlanner,
    planQuery
} from '@cocreate/db'

// DB setup.
const db = await createDB(server, {
    config,
    disk,
    persistence,
    size: 64,
    leafSize: 64
})

// Select an organization-scoped Tree.
const organizationTree = await db.organization.get(organizationId)

// Create and initialize another Tree instance.
const persistenceTree = new Tree()
persistenceTree.disk = persistenceDisk
persistenceTree.persistence = persistenceAdapter

const persistencePlanner = new QueryPlanner()
persistenceTree.planner = (branch, payload = {}) =>
    persistencePlanner.plan(
        branch,
        payload.query ?? payload.filter?.query ?? {}
    )

await persistenceTree.init({
    ...organizationTree.config,
    size: organizationTree.size,
    leafSize: organizationTree.leafSize
})

// Tree configuration and composition.
const configSnapshot = persistenceTree.config
const roots = await persistenceTree.roots.get()
const oneRoot = await persistenceTree.roots.get('storage.database')

await persistenceTree.roots.execute({
    operation: 'set',
    path: 'storage.database',
    data: updatedRootDefinition
})

persistenceTree.disk = anotherDiskAdapter
persistenceTree.persistence = anotherPersistenceAdapter
persistenceTree.setDiskFirst(false)

const pendingIndexes = persistenceTree.pendingIndexCount

// Branch, planner, and leaf query flow.
const payload = {
    method: 'object.read',
    organization_id: organizationId,
    storage: 'storage-name',
    database: 'database-name',
    array: 'contacts'
}

const primaryBranch = await persistenceTree.getPrimaryBranch(payload)
const plan = await persistenceTree.planner(primaryBranch, {
    ...payload,
    query: { status: 'active' }
})

const planFromHelper = planQuery(primaryBranch, { status: 'active' })

for await (const leaf of persistenceTree.getLeaves(plan)) {
    // Process a leaf returned by the plan.
}

// Direct branch and leaf access.
const branch = await persistenceTree.branches.get(branchUuid)
const leaf = await persistenceTree.leaves.get(leafUuid)
const hasLeaf = await persistenceTree.leaves.has(leafUuid)
const sameLeaf = await persistenceTree.getLeaf(leafUuid)

// Tree index range and visitor APIs.
for await (const entry of persistenceTree.range('status', 'string', {
    min: 'active',
    max: 'active'
})) {
    // Process an index entry.
}

for await (const matchingLeaf of persistenceTree.rangeLeaves(
    'status',
    'string',
    { min: 'active', max: 'active' }
)) {
    // Process a leaf from the range.
}

await persistenceTree.visitRange(
    'status',
    'string',
    { min: 'active', max: 'active' },
    async (matchingLeaf, entry) => {
        // Visit one indexed match.
    }
)

await persistenceTree.visitRanges(
    'status',
    'string',
    [{ min: 'active', max: 'active' }],
    async matchingLeaf => {
        // Visit matches across ranges.
    }
)

await persistenceTree.visitLeaves(async currentLeaf => {
    // Visit every resident leaf.
})

// Direct leaf mutations and Tree lifecycle.
const createdLeaf = await persistenceTree.createLeaf(
    'object',
    { status: 'active' },
    payload
)

const createdLeaves = await persistenceTree.createLeaves(
    'object',
    [{ status: 'active' }, { status: 'pending' }],
    payload
)

await persistenceTree.updateLeaf(createdLeaf.uuid, { status: 'pending' })
await persistenceTree.matchesRoot(payload, 'object', createdLeaf)
await persistenceTree.removeLeaf(createdLeaf.uuid)
await persistenceTree.evictLeaf(createdLeaf.uuid)

await persistenceTree.prune({ strategy: 'lfu', limit: 100 })
await persistenceTree.close()

// CRUD composed with a Tree.
const planner = new QueryPlanner()
const crud = createCRUD(persistenceTree, planner)
const crudInstance = new CRUD(persistenceTree, planner)

await crud.send({
    ...payload,
    method: 'object.read',
    filter: { query: { status: 'active' } }
})

// DB-level organization and lifecycle APIs.
await db.send({ ...payload, method: 'object.read' })
await db.organization.release(organizationId)
await db.persist()
await db.close()

// Initialize another Tree with a configuration supplied by its composer.
const initializedTree = new Tree()
await initializedTree.init(config)

// Static Tree helpers.
await Tree.readDiskConfig(disk)
await Tree.clearDisk(disk)

// Other DB composition entry points.
const composedDB = await createDB(server, { tree: initializedTree })
const initializedDB = await init(server, options)
