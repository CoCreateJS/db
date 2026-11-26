import { Tree } from '../src/index.js'
import { createConfiguration } from '../src/runtime.js'
import { treeContexts } from '../src/tree/internal.js'

export async function createTestTree(options = {}) {
    const { disk, persistence, config, ...treeOptions } = options
    const tree = new Tree()
    if (disk) tree.disk = disk
    if (persistence) tree.persistence = persistence
    await tree.init({
        ...createConfiguration(config ?? treeOptions),
        ...treeOptions
    })
    return inspectTree(tree)
}

// Internal engine inspection for tests; callers of @cocreate/db use Tree's
// public execute/config/ports/lifecycle interface directly.
export function inspectTree(tree) {
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
