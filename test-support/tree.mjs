import { createConfiguration, Tree } from '../src/index.js'

export async function createTestTree(options = {}) {
    const { disk, persistence, config, ...treeOptions } = options
    const tree = new Tree()
    if (disk) tree.disk = disk
    if (persistence) tree.persistence = persistence
    await tree.init({
        ...createConfiguration(config ?? treeOptions),
        ...treeOptions
    })
    return tree
}
