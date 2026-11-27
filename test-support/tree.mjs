import { after } from 'node:test'
import { Trees } from '../src/trees.js'
import { createConfiguration } from '../src/runtime.js'
import { Organization } from '../src/organization.js'
import { treeContexts } from '../src/tree/internal.js'

const organizations = new Set()
const stores = new WeakMap()
after(async () => { for (const organization of organizations) await organization.close() })

export async function createTestTree(options = {}) {
    const { disk, persistence, config, ...treeOptions } = options
    const store = new Trees({ disk, persistence })
    const organization = await new Organization(undefined, { disk, persistence, treeOptions,
        dispatch: command => store.execute(command) }).init(createConfiguration(config ?? treeOptions))
    stores.set(organization, store)
    organizations.add(organization)
    return inspectOrganization(organization)
}

// Test-only inspection of the organization router and its independent engines.
export function inspectOrganization(organization, store = stores.get(organization)) {
    stores.set(organization, store)
    const tables = () => store.organizations.get(organization.organizationId) ?? new Map()
    const engines = () => [...tables().values()]
    const contexts = () => engines().map(tree => treeContexts.get(tree)).filter(Boolean)
    const locate = async id => {
        for (const tree of engines()) if (treeContexts.get(tree)?.referenceLeaf(id)) return tree
        for (const tree of engines()) if (await tree.leaves.get(id)) return tree
    }
    const create = async (root, values, payload) => {
        const result = await organization.execute({ ...payload, method: `${root}.create`, [root]: values })
        if (!result.success) throw new Error(result.error.join('; '))
        return result[root]
    }
    const proxy = new Proxy(organization, {
        get(target, property) {
            if (property === 'trees') return tables()
            if (property === 'pendingDiskCount') return store.status(organization.organizationId).pendingDiskCount
            if (property === 'pendingIndexCount') return store.status(organization.organizationId).pendingIndexCount
            if (property === 'pruneCandidates') return engines().filter(tree => treeContexts.get(tree)?.canDrop)
            if (property === 'getTree') return uuid => store.get(organization.organizationId, uuid, organization.configuration(uuid))
            if (property === 'config') {
                const config = organization.config
                config.indexes = engines().flatMap(tree => tree.config.indexes.map(index => ({ ...index, primary: tree.uuid })))
                config.diskFirst = false
                return config
            }
            if (property === 'leaves') return {
                get: async id => { const tree = await locate(id); return tree?.leaves.get(id) },
                has: async id => !!await locate(id)
            }
            if (property === 'createLeaf') return async (root, value, payload) => (await create(root, [value], payload))[0]
            if (property === 'createLeaves') return create
            if (property === 'getLeaf') return async id => (await locate(id))?.leaves.get(id)
            if (property === 'updateLeaf' || property === 'removeLeaf') return async (id, patch) => treeContexts.get(await locate(id))[property](id, patch)
            if (property === 'getPrimaryBranch') return async payload => {
                // Route a read without performing query I/O, then inspect its engine.
                const root = payload.method.split('.')[0]
                const read = await organization.execute({ ...payload, method: `${root}.read` })
                if (!read.success) throw Error(read.error.join('; '))
                const config = organization.config
                const candidates = engines().filter(tree => Object.hasOwn(tree.config.roots, root))
                const tree = candidates.find(tree => {
                    let id = tree.config.parent
                    while (id !== undefined) {
                        const node = config.leaves[id]
                        const ref = payload[node.root.startsWith('$') ? node.root.slice(1) : node.root]
                        if (ref && (typeof ref === 'string' ? ref !== node.name : ref.uuid ? ref.uuid !== id : ref.name !== node.name)) return false
                        id = node.parent
                    }
                    return true
                })
                return await treeContexts.get(tree).getPrimaryBranch(payload)
            }
            if (property === 'getLeaves') return async function* (plan) { const tree = await store.get(organization.organizationId, plan.primary, organization.configuration(plan.primary)); yield* treeContexts.get(tree).getLeaves(plan) }
            if (property === 'planner') return engines().at(-1)?.planner
            if (property === 'branches') return { get: async id => { for (const context of contexts()) { const branch = await context.branches.get(id); if (branch) return branch } } }
            if (property === 'range' || property === 'rangeLeaves') return async function* (...args) { for (const context of contexts()) yield* context[property](...args) }
            if (['visitLeaves','visitRange','visitRanges'].includes(property)) return async (...args) => { let count = 0; for (const context of contexts()) count += await context[property](...args); return count }
            if (property === 'setReadExternal') return read => { for (const context of contexts()) context.setReadExternal(read) }
            const value = Reflect.get(target, property, target)
            return typeof value === 'function' ? value.bind(target) : value
        },
        set(target, property, value) {
            if (property === 'persistence' || property === 'disk') for (const tree of engines()) tree[property] = value
            return Reflect.set(target, property, value, target)
        }
    })
    stores.set(proxy, store)
    return proxy
}

export function inspectTree(tree) {
    if (tree instanceof Organization) return inspectOrganization(tree)
    return new Proxy(tree, {
        get(target, key) {
            const context = treeContexts.get(target)
            if (context && key in context) return context[key]
            const value = Reflect.get(target, key, target)
            return typeof value === 'function' ? value.bind(target) : value
        },
        set(target, key, value) {
            const context = treeContexts.get(target)
            if (context && key in context && key !== 'planner') { context[key] = value; return true }
            return Reflect.set(target, key, value, target)
        }
    })
}

export async function testOrganization(db, id) {
    const { databaseRuntimes } = await import('../src/runtime.js')
    const runtime = databaseRuntimes.get(db) ?? db
    return inspectOrganization(await db.organizations.get(id), runtime.trees)
}
