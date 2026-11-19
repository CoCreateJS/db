/********************************************************************************
 * Copyright (C) 2023-2026 CoCreate and Contributors.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 ********************************************************************************/

// Commercial Licensing Information:
// For commercial use of this software without the copyleft provisions of the AGPLv3,
// you must obtain a commercial license from CoCreate LLC.
// For details, visit <https://CoCreateJS.com/licenses/> or contact us at sales@CoCreateJS.com.

/**
 * CoCreate Index — filesystem-backed prototype (ESM, Node.js).
 * Logical address: database + array + key. Each key has type-specific trees.
 * Nodes are independently stored JSON files; internal references use IDs.
 *
 * Prototype limitations: single-writer only; no transactional multi-file commit,
 * locking, crash recovery, snapshots, or cross-process cache invalidation.
 * Index values: property paths and type-specific values reference their object artifacts.
 */
import { rm } from '../io.js'
import { replaceJSON } from '../storage.js'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { uuid } from '@cocreate/utils'
import { arrayDigest } from '../entries.js'
import { live } from '../mutation.js'
import { registerPartition } from '../partition.js'
import { readMemoryJSON, removeMemoryPath, memoryEnabled } from '../memory.js'

import { stableId } from '../files.js'
import { afterResponse } from '../resolution.js'

const newId = () => uuid().replaceAll('-', '')
export const indexId = stableId
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0
const lowerBound = (items, value, afterEquals, field = 0) => {
    let lo = 0, hi = items.length
    while (lo < hi) {
        const mid = (lo + hi) >>> 1
        const boundary = items[mid][field]
        if (boundary < value || afterEquals && boundary === value) lo = mid + 1
        else hi = mid
    }
    return lo
}
const lowerBoundUuid = (uuids, value) => {
    let lo = 0, hi = uuids.length
    while (lo < hi) {
        const mid = (lo + hi) >>> 1
        if (uuids[mid] < value) lo = mid + 1
        else hi = mid
    }
    return lo
}
const uuidCount = entries => entries.reduce((count, [, uuids]) => count + uuids.length, 0)
const typeOf = value => value === null ? 'null' :
    value === undefined ? 'undefined' :
    Array.isArray(value) ? 'array' :
    typeof value === 'object' ? 'object' :
    typeof value === 'boolean' ? 'boolean' :
        typeof value === 'string' ? 'string' :
            typeof value === 'number' && Number.isFinite(value) ? 'number' : null

export function createIndex({
    directory = './indexes',
    maxBytes = 128 * 1024,
    cache: cacheEnabled = false,
    resolveArrayDirectory,
    indexDirectoryName = 'index',
    indexRoot = directory,
    flat = true,
    catalogIdForDirectory,
    artifacts,
    readArtifact,
    writeArtifact,
    deleteArtifact,
    onPartitionChange: partitionChange,
    readIndexedValue,
    readPartition
} = {}) {
    if (maxBytes < 512) throw new Error('maxBytes must be at least 512')
    if (typeof indexDirectoryName !== 'string' || !indexDirectoryName || indexDirectoryName === '.' || indexDirectoryName === '..' || /[\\/\0]/.test(indexDirectoryName))
        throw new TypeError('indexDirectoryName must be a safe directory name')
    const base = resolve(directory)
    const origin = flat ? resolve(indexRoot) : base
    // Index operations repeatedly address the same arrays and UUID files. Keep
    // their immutable filesystem paths so hot inserts/scans do not redo path
    // normalization and relative-path work for every leaf.
    const arrayDirectories = new Map()
    const indexRootDirectory = flat ? join(origin, 'indexes') : undefined
    const indexDirectories = new Map()
    const catalogIds = new Map()
    const nodeFiles = new Map()
    const partitionPaths = new Map()
    const cache = cacheEnabled ? new Map() : null
    const indexedValues = new Map()
    const reportedPartitions = new Set()
    const onPartitionChange = partitionChange && (change => {
        const notify = async () => {
            try { await partitionChange(change) }
            catch (error) { reportedPartitions.delete(join(origin, change.path)); throw error }
        }
        if (!afterResponse(notify)) return notify()
    })
    const parents = new Map()
    let remembered = new WeakSet()
    let changedPartitions
    let catalogBatch
    const catalogBatchRoot = (dir, key, type, value) => {
        let keys = catalogBatch?.roots.get(dir)
        if (!keys && value !== undefined) catalogBatch.roots.set(dir, keys = new Map())
        let types = keys?.get(key)
        if (!types && value !== undefined) keys.set(key, types = new Map())
        if (value !== undefined) types.set(type, value)
        return types?.get(type)
    }
    const remember = (file, node, changed = false) => {
        if (!node || (!changed && remembered.has(node))) return node
        remembered.add(node)
        const dir = flat ? undefined : join(file, '..', '..')
        for (const child of node.indexes ?? []) parents.set(nodeFile(dir, child.uuid), file)
        if (node.kind === 'catalog')
            for (const entry of node.entries ?? []) parents.set(nodeFile(dir, entry[2]), file)
        registerPartition(node, bytes => bytes > maxBytes ? splitForSend(file, node) : undefined)
        return node
    }

    const address = (database, array) => {
        for (const part of [database, array]) {
            if (typeof part !== 'string' || !part || part === '.' || part === '..' || /[\\/\0]/.test(part))
                throw new Error('Invalid database or array name')
        }
        let arrays = arrayDirectories.get(database)
        if (arrays?.has(array)) return arrays.get(array)
        if (!arrays) arrayDirectories.set(database, arrays = new Map())
        if (!resolveArrayDirectory) {
            const dir = join(base, encodeURIComponent(database), encodeURIComponent(array))
            arrays.set(array, dir)
            return dir
        }

        const customDirectory = resolve(resolveArrayDirectory({
            directory: base,
            database,
            array
        }))
        const relativeDirectory = relative(base, customDirectory)

        if (isAbsolute(relativeDirectory) || relativeDirectory === '..' || relativeDirectory.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
            throw new Error('Resolved array directory must stay inside the configured directory')

        arrays.set(array, customDirectory)
        return customDirectory
    }

    const indexDirectory = dir => {
        if (!indexDirectories.has(dir)) indexDirectories.set(dir, join(dir, indexDirectoryName))
        return indexDirectories.get(dir)
    }
    const catalogRootId = dir => {
        if (!flat) return 'root'
        if (!catalogIds.has(dir)) catalogIds.set(dir, catalogIdForDirectory?.(dir) ?? indexId(relative(origin, dir)))
        return catalogIds.get(dir)
    }
    const artifactId = file => basename(file, '.json')
    const nodeFile = (dir, id) => {
        if (flat && !/^[a-f0-9]{32}$/i.test(id)) throw new TypeError('Invalid index node ID')
        let files = nodeFiles.get(dir)
        if (!files) nodeFiles.set(dir, files = new Map())
        if (!files.has(id)) files.set(id, join(flat ? indexRootDirectory : indexDirectory(dir), `${id === 'root' ? 'index' : id}.json`))
        return files.get(id)
    }
    const normalizedValue = (value, type = typeOf(value)) =>
        type === 'array' || type === 'object' ? arrayDigest(value) : type === 'undefined' ? '\0cocreate:undefined' : value
    const indexedValueId = (dir, key, objectId, type, digest) =>
        JSON.stringify([catalogRootId(dir), key, objectId, type, digest])
    const readIndexed = async (dir, database, array, key, objectId, type, digest) => {
        const id = indexedValueId(dir, key, objectId, type, digest)
        if (indexedValues.has(id)) return live(indexedValues.get(id))
        const value = await readIndexedValue?.({ catalog: catalogRootId(dir), database, array, objectId, key, type, digest })
        if (value !== undefined && !readIndexedValue) indexedValues.set(id, value)
        return live(value)
    }

    const partitionPath = file => {
        if (!partitionPaths.has(file)) partitionPaths.set(file, relative(origin, file).split(/[\\/]/).join('/'))
        return partitionPaths.get(file)
    }

    const reportLocalPartition = async (file, value) => {
        if (!onPartitionChange || reportedPartitions.has(file)) return
        await onPartitionChange({
            path: partitionPath(file),
            operation: 'set',
            value: live(value),
            acquired: true
        })
        reportedPartitions.add(file)
    }

    const readJSON = async (file, uuid = artifactId(file)) => {
        if (!artifacts && !readArtifact && cache?.has(file)) {
            const value = live(cache.get(file))
            await reportLocalPartition(file, value)
            return remember(file, live(value))
        }

        let value

        value = artifacts?.has(uuid) ? artifacts.get(uuid)
            : readArtifact ? await readArtifact(uuid) : await readMemoryJSON(file)
        if (value === undefined) {
            if (!readPartition) return undefined
            value = await readPartition(partitionPath(file))
            if (value === undefined) return undefined
            await writeJSON(file, value, { acquired: true })
            return live(value)
        }

        if (artifacts && value && typeof value === 'object') artifacts.set(uuid, value)
        else if (!readArtifact) cache?.set(file, live(value))
        await reportLocalPartition(file, value)
        return remember(file, value)
    }

    const writeJSON = async (file, value, { acquired = false, notify = true } = {}) => {
        value = writeArtifact
            ? await writeArtifact(value.uuid ?? artifactId(file), value)
            : await replaceJSON(file, value)
        if (artifacts && value?.uuid) artifacts.set(value.uuid, value)
        else if (!writeArtifact) cache?.set(file, live(value))
        remember(file, value, true)
        changedPartitions?.set(partitionPath(file), value)
        if (notify && onPartitionChange) {
            await onPartitionChange({
                path: partitionPath(file),
                operation: 'set',
                value: live(value),
                acquired
            })
            reportedPartitions.add(file)
        }
        return value
    }

    const getNode = async (dir, id) => readJSON(nodeFile(dir, id), id)
    const setNode = (dir, node) => {
        if (flat) {
            node.catalog = catalogRootId(dir)
            if (node.uuid === node.catalog) node.path = relative(origin, dir).split(/[\\/]/).join('/')
        }
        return writeJSON(nodeFile(dir, node.uuid), node)
    }

    const getCatalogNode = async (dir, id) => {
        let node = await readJSON(nodeFile(dir, id), id)

        if (!node && id === catalogRootId(dir)) {
            return updateCatalogNode({ uuid: id, kind: 'catalog', length: 0, entries: [] })
        }
        return node
    }
    const setCatalogNode = setNode
    const deleteCatalogNode = async (dir, id) => {
        if (id !== catalogRootId(dir)) await deleteNode(dir, id)
    }

    const deleteNode = async (dir, id) => {
        const file = nodeFile(dir, id)

        cache?.delete(file)
        artifacts?.delete(id)
        removeMemoryPath(file)
        reportedPartitions.delete(file)
        parents.delete(file)
        if (deleteArtifact) await deleteArtifact(id)
        else await rm(file, { force: true })
        if (onPartitionChange)
            await onPartitionChange({ path: partitionPath(file), operation: 'remove' })
    }

    const resolvePartitionFile = path => {
        if (typeof path !== 'string' || !/^indexes\/[a-f0-9]{32}\.json$/i.test(path))
            throw new TypeError('Invalid index partition path')
        return join(origin, path)
    }


    const ref = node => ({
        uuid: node.uuid,
        length: node.length,
        firstValue: node.firstValue,
        firstUuid: node.firstUuid,
        lastValue: node.lastValue,
        lastUuid: node.lastUuid
    })

    const update = (node, lengthDelta) => {
        const items = node.entries ?? node.indexes

        node.length = node.entries
            ? lengthDelta === undefined ? uuidCount(items) : node.length + lengthDelta
            : items.reduce((n, item) => n + item.length, 0)

        const first = items[0]
        const last = items.at(-1)
        node.firstValue = first ? (node.entries ? first[0] : first.firstValue) : null
        node.firstUuid = first ? (node.entries ? first[1][0] : first.firstUuid) : null
        node.lastValue = last ? (node.entries ? last[0] : last.lastValue) : null
        node.lastUuid = last ? (node.entries ? last[1].at(-1) : last.lastUuid) : null

        return node
    }

    const compareCatalogKey = (a, b) => compare(a[0], b[0]) || compare(a[1], b[1])
    const catalogBoundary = entry => [entry[0], entry[1]]
    const catalogRef = node => ({
        uuid: node.uuid,
        length: node.catalogLength,
        firstValue: node.firstValue,
        firstUuid: node.firstUuid,
        lastValue: node.lastValue,
        lastUuid: node.lastUuid
    })
    const updateCatalogNode = node => {
        const items = node.entries ?? node.indexes
        node.catalogLength = node.entries
            ? items.length
            : items.reduce((length, item) => length + item.length, 0)
        const first = items[0]
        const last = items.at(-1)
        node.firstValue = first ? (node.entries ? catalogBoundary(first) : first.firstValue) : null
        node.firstUuid = first ? (node.entries ? first[2] : first.firstUuid) : null
        node.lastValue = last ? (node.entries ? catalogBoundary(last) : last.lastValue) : null
        node.lastUuid = last ? (node.entries ? last[2] : last.lastUuid) : null
        return node
    }

    const splitCatalogNode = node => {
        const property = node.entries ? 'entries' : 'indexes'
        const items = node[property]
        const at = Math.ceil(items.length / 2);

        const moved = items.splice(at)
        for (let i = 0; i < moved.length; i++) moved[i] = live(moved[i])
        const sibling = { uuid: newId(), kind: 'catalog', [property]: moved }
        updateCatalogNode(node)
        updateCatalogNode(sibling)
        return sibling
    }

    const findPosition = (items, entry, comparator) => {
        let lo = 0
        let hi = items.length

        while (lo < hi) {
            const mid = (lo + hi) >>> 1

            if (comparator(items[mid], entry) < 0)
                lo = mid + 1
            else
                hi = mid
        }

        return lo
    }

    const chooseChild = (children, entry) => {
        // Choose first child whose last entry >= target,
        // otherwise the last child.

        let lo = 0
        let hi = children.length

        while (lo < hi) {
            const mid = (lo + hi) >>> 1

            if ((compare(children[mid].lastValue, entry[0]) || compare(children[mid].lastUuid, entry[1])) < 0)
                lo = mid + 1
            else
                hi = mid
        }

        return Math.min(lo, children.length - 1)
    }

    const split = node => {
        const property = node.entries ? 'entries' : 'indexes'
        const items = node[property]

        let moved
        if (node.entries && items.length === 1 && items[0][1].length > 1) {
            const [value, uuids] = items[0]
            moved = [[value, uuids.splice(Math.ceil(uuids.length / 2))]]
        } else {
            const at = Math.ceil(items.length / 2)
            moved = items.splice(at)
        }
        for (let i = 0; i < moved.length; i++) moved[i] = live(moved[i])
        const sibling = {
            uuid: newId(),
            [property]: moved
        }

        update(node)
        update(sibling)

        return sibling
    }

    const insertNode = async (dir, id, entry) => {
        const node = await getNode(dir, id)

        if (!node)
            throw new Error(`Missing index node ${id}`)

        if (node.entries) {
            const at = lowerBound(node.entries, entry[0], false)
            const group = node.entries[at]
            if (group && compare(group[0], entry[0]) === 0) {
                const uuidAt = lowerBoundUuid(group[1], entry[1])
                if (group[1][uuidAt] === entry[1]) return [node]
                group[1].splice(uuidAt, 0, entry[1])
            } else node.entries.splice(at, 0, [entry[0], [entry[1]]])
        } else {
            const at = chooseChild(node.indexes, entry)

            const children = await insertNode(
                dir,
                node.indexes[at].uuid,
                entry
            )

            node.indexes.splice(
                at,
                1,
                ...children.map(ref)
            )
        }

        update(node, node.entries ? 1 : undefined)

        await setNode(dir, node)
        return [node]
    }

    const removeNode = async (dir, id, entry) => {
        const node = await getNode(dir, id)

        if (!node)
            throw new Error(`Missing index node ${id}`)

        if (node.entries) {
            const at = lowerBound(node.entries, entry[0], false)
            const group = node.entries[at]
            if (!group || compare(group[0], entry[0]) !== 0) return { node, removed: false }
            const uuidAt = lowerBoundUuid(group[1], entry[1])
            if (group[1][uuidAt] !== entry[1]) return { node, removed: false }
            group[1].splice(uuidAt, 1)
            if (!group[1].length) node.entries.splice(at, 1)
            update(node, -1)
        } else {
            const at = chooseChild(node.indexes, entry)

            const result = await removeNode(
                dir,
                node.indexes[at].uuid,
                entry
            )

            if (!result.removed)
                return { node, removed: false }

            if (result.node)
                node.indexes[at] = ref(result.node)
            else
                node.indexes.splice(at, 1)
        }

        if (!node.entries) update(node)

        if (!node.length) {
            await deleteNode(dir, id)

            return {
                node: null,
                removed: true
            }
        }

        await setNode(dir, node)

        return {
            node,
            removed: true
        }
    }

    const chooseCatalogChild = (children, entry) => {
        let lo = 0
        let hi = children.length

        while (lo < hi) {
            const mid = (lo + hi) >>> 1
            if (compareCatalogKey(children[mid].lastValue, entry) < 0) lo = mid + 1
            else hi = mid
        }

        return Math.min(lo, children.length - 1)
    }

    const insertCatalogNode = async (dir, id, entry) => {
        const node = await getCatalogNode(dir, id)

        if (!node) throw new Error(`Missing catalog node ${id}`)

        if (node.entries) {
            const key = catalogBoundary(entry)
            const at = findPosition(node.entries, key, compareCatalogKey)

            if (at < node.entries.length && compareCatalogKey(catalogBoundary(node.entries[at]), key) === 0)
                node.entries[at] = entry
            else
                node.entries.splice(at, 0, entry)
        } else {
            const at = chooseCatalogChild(node.indexes, catalogBoundary(entry))
            const children = await insertCatalogNode(dir, node.indexes[at].uuid, entry)
            node.indexes.splice(at, 1, ...children.map(catalogRef))
        }

        updateCatalogNode(node)

        await setCatalogNode(dir, node)
        return [node]
    }

    const removeCatalogNode = async (dir, id, key) => {
        const node = await getCatalogNode(dir, id)

        if (!node) throw new Error(`Missing catalog node ${id}`)

        if (node.entries) {
            const at = findPosition(node.entries, key, compareCatalogKey)
            if (at >= node.entries.length || compareCatalogKey(catalogBoundary(node.entries[at]), key) !== 0)
                return { node, removed: false }
            node.entries.splice(at, 1)
        } else {
            const at = chooseCatalogChild(node.indexes, key)
            const result = await removeCatalogNode(dir, node.indexes[at].uuid, key)
            if (!result.removed) return { node, removed: false }
            if (result.node) node.indexes[at] = catalogRef(result.node)
            else node.indexes.splice(at, 1)
        }

        updateCatalogNode(node)

        if (!node.catalogLength && id !== catalogRootId(dir)) {
            await deleteCatalogNode(dir, id)
            return { node: null, removed: true }
        }

        await setCatalogNode(dir, node)
        return { node, removed: true }
    }

    const setCatalogRoot = async (dir, key, type, rootId, rootNode) => {
        if (catalogBatch) {
            catalogBatchRoot(dir, key, type, { dir, key, type, rootId, rootNode })
            return
        }
        const entryKey = [key, type]
        if (rootId) {
            const node = rootNode ?? await getNode(dir, rootId)
            await insertCatalogNode(dir, catalogRootId(dir), [key, type, rootId, {
                length: node.length, firstValue: node.firstValue, firstUuid: node.firstUuid,
                lastValue: node.lastValue, lastUuid: node.lastUuid
            }])
            return
        }

        if (!await getCatalogRoot(dir, key, type)) return
        await removeCatalogNode(dir, catalogRootId(dir), entryKey)

        let current = await getCatalogNode(dir, catalogRootId(dir))
        while (current.indexes?.length === 1) {
            const child = await getCatalogNode(dir, current.indexes[0].uuid)
            const objectLength = current.length ?? 0
            await deleteCatalogNode(dir, child.uuid)
            const property = child.entries ? 'entries' : 'indexes'
            delete current.entries
            delete current.indexes
            current[property] = live(child[property])
            current.kind = 'catalog'
            current.length = objectLength
            updateCatalogNode(current)
            await setCatalogNode(dir, current)
        }

        // Keep a stable empty root after the last catalog entry is removed.
        if (!current.catalogLength && !current.entries)
            await setCatalogNode(dir, updateCatalogNode({
                uuid: catalogRootId(dir),
                kind: 'catalog',
                length: current.length ?? 0,
                entries: []
            }))
    }

    const readLookupNode = async (file, load, nodes) => {
        if (nodes?.has(file)) return nodes.get(file)
        const node = await load()
        nodes?.set(file, node)
        return node
    }

    const getCatalogEntry = async (dir, key, type, nodes) => {
        const read = id => readLookupNode(nodeFile(dir, id), () => getCatalogNode(dir, id), nodes)
        const entry = [key, type]
        let node = await read(catalogRootId(dir))

        while (node) {
            if (node.entries) {
                const at = findPosition(node.entries, entry, compareCatalogKey)
                return at < node.entries.length && compareCatalogKey(catalogBoundary(node.entries[at]), entry) === 0
                    ? node.entries[at]
                    : undefined
            }
            node = await read(node.indexes[chooseCatalogChild(node.indexes, entry)].uuid)
        }
    }

    const getCatalogRoot = async (dir, key, type) => {
        const batched = catalogBatchRoot(dir, key, type)
        if (batched) return batched.rootId
        return (await getCatalogEntry(dir, key, type))?.[2]
    }

    // Resolve statistics from catalog boundaries without loading value roots.
    const getMetadata = async (database, array, key = '_id') => {
        const dir = address(database, array)
        const indexes = {}
        const visit = async node => {
            if (node.entries) {
                for (const entry of node.entries) {
                    if (entry[0] !== key) continue
                    const metadata = entry[3] ?? await getNode(dir, entry[2])
                    if (!metadata) throw new Error(`Missing index node ${entry[2]}`)
                    indexes[entry[1]] = { uuid: entry[2], length: metadata.length,
                        firstValue: metadata.firstValue, firstUuid: metadata.firstUuid,
                        lastValue: metadata.lastValue, lastUuid: metadata.lastUuid }
                }
            } else {
                for (const child of node.indexes)
                    if (child.firstValue[0] <= key && child.lastValue[0] >= key)
                        await visit(await getCatalogNode(dir, child.uuid))
            }
        }
        await visit(await getCatalogNode(dir, catalogRootId(dir)))
        return { database, array, key, indexes }
    }

    const liftCatalogRoot = async (dir, root, sibling) => {
        const property = root.entries ? 'entries' : 'indexes'
        const left = updateCatalogNode({ uuid: newId(), kind: 'catalog', [property]: live(root[property]) })
        await setCatalogNode(dir, left)
        await setCatalogNode(dir, sibling)
        delete root.entries
        root.indexes = [catalogRef(left), catalogRef(sibling)]
        updateCatalogNode(root)
        await setCatalogNode(dir, root)
        return root
    }

    const adjustLength = async (dir, delta) => {
        if (catalogBatch) {
            catalogBatch.lengths[dir] = (catalogBatch.lengths[dir] ?? 0) + delta
            return
        }
        const root = await getCatalogNode(dir, catalogRootId(dir))
        const currentLength = Number.isSafeInteger(root.length) && root.length >= 0
            ? root.length
            : 0
        root.length = Math.max(0, currentLength + delta)

        await setCatalogNode(dir, root)
    }

    // Register ancestry after a cold direct partition read. Catalogs identify
    // field roots; only a candidate root's ordered path is followed below it.
    const findParent = async (dir, target) => {
        const targetFile = nodeFile(dir, target.uuid)
        const visitCatalog = async node => {
            if (node.indexes) {
                for (const child of node.indexes) {
                    const found = await visitCatalog(await getCatalogNode(dir, child.uuid))
                    if (found) return true
                }
            } else if (target.kind !== 'catalog') {
                for (const entry of node.entries) {
                    let current = await getNode(dir, entry[2])
                    while (current) {
                        if (current.uuid === target.uuid) return true
                        if (!current.indexes || target.firstValue === undefined) break
                        if (typeof current.firstValue !== typeof target.firstValue) break
                        current = await getNode(dir, current.indexes[chooseChild(current.indexes, [target.firstValue, target.firstUuid])].uuid)
                    }
                }
            }
            return parents.has(targetFile)
        }
        await visitCatalog(await getCatalogNode(dir, catalogRootId(dir)))
    }

    const splitForSend = async (file, node) => {
        // Oversized indivisible values and minimum-fanout nodes are valid.
        if (node.entries
            ? node.entries.length < 2 && !(node.kind !== 'catalog' && node.entries.length === 1 && node.entries[0][1].length > 1)
            : !node.indexes || node.indexes.length < 4) return
        const catalog = flat ? await readJSON(nodeFile(undefined, node.catalog)) : undefined
        const dir = flat ? resolve(origin, catalog.path) : join(file, '..', '..')
        if (flat && (relative(origin, dir).startsWith('..') || isAbsolute(relative(origin, dir)))) throw new Error('Invalid index catalog path')
        if (node.uuid !== catalogRootId(dir) && !parents.has(file)) await findParent(dir, node)
        if (node.uuid !== catalogRootId(dir) && !parents.has(file)) return
        const changes = new Map()
        changedPartitions = changes
        try {
            if (node.kind === 'catalog' && node.uuid === catalogRootId(dir)) {
                await liftCatalogRoot(dir, node, splitCatalogNode(node))
            } else {
                const sibling = node.kind === 'catalog' ? splitCatalogNode(node) : split(node)
                await writeJSON(file, node)
                await setNode(dir, sibling)
                let children = [node, sibling], childFile = file
                const ancestors = new Set()
                while (parents.has(childFile)) {
                    if (ancestors.has(childFile)) throw new Error(`Cyclic index parent reference: ${childFile}`)
                    ancestors.add(childFile)
                    const parentFile = parents.get(childFile)
                    const parent = await readJSON(parentFile)
                    if (!parent) throw new Error('Missing parent of index partition')
                    if (parent.entries && parent.kind === 'catalog') {
                        const entry = parent.entries.find(entry => nodeFile(dir, entry[2]) === childFile)
                        if (!entry) throw new Error('Missing field root in index catalog')
                        let root = children[0]
                        if (children.length > 1) {
                            root = update({ uuid: newId(), indexes: children.map(ref) })
                            await setNode(dir, root)
                        }
                        entry[2] = root.uuid
                        entry[3] = { length: root.length, firstValue: root.firstValue, firstUuid: root.firstUuid, lastValue: root.lastValue, lastUuid: root.lastUuid }
                    } else {
                        const at = parent.indexes.findIndex(child => nodeFile(dir, child.uuid) === childFile)
                        if (at < 0) throw new Error('Missing child in index parent')
                        parent.indexes.splice(at, 1, ...children.map(parent.kind === 'catalog' ? catalogRef : ref))
                    }
                    if (parent.kind === 'catalog') updateCatalogNode(parent)
                    else update(parent)
                    await writeJSON(parentFile, parent)
                    children = [parent]
                    childFile = parentFile
                }
            }
        } finally { changedPartitions = undefined }
        return { path: partitionPath(file), partitions: [...changes].map(([path, value]) => ({ path, value })) }
    }

    const containsNode = async (dir, id, entry) => {
        const node = await getNode(dir, id)

        if (!node)
            throw new Error(`Missing index node ${id}`)

        if (node.entries) {
            const at = lowerBound(node.entries, entry[0], false)
            const group = node.entries[at]
            if (!group || compare(group[0], entry[0]) !== 0) return false
            const uuidAt = lowerBoundUuid(group[1], entry[1])
            return group[1][uuidAt] === entry[1]
        }

        const at = chooseChild(node.indexes, entry)
        return containsNode(dir, node.indexes[at].uuid, entry)
    }

    const root = async (dir, key, type) => {
        const id = await getCatalogRoot(dir, key, type)

        return id
            ? getNode(dir, id)
            : undefined
    }

    const setRoot = setCatalogRoot

    const insert = async (
        database,
        array,
        key,
        value,
        objectId
    ) => {
        const type = typeOf(value)

        if (!type)
            throw new TypeError(
                'Only finite numbers, strings, booleans, null, undefined, objects, and arrays can be indexed'
            )

        if (typeof objectId !== 'string')
            throw new TypeError('objectId must be a string')

        const dir = address(database, array)
        const indexedValue = normalizedValue(value, type)
        if ((type === 'array' || type === 'object') && !readIndexedValue)
            indexedValues.set(indexedValueId(dir, key, objectId, type, indexedValue), live(value))
        const existing = await root(dir, key, type)

        const entry = [indexedValue, objectId]
        const isNewObjectId = key === '_id' && (!existing || !await containsNode(dir, existing.uuid, entry))

        if (!existing) {
            const node = update({
                uuid: newId(),
                entries: [[indexedValue, [objectId]]]
            })

            await setNode(dir, node)
            await setRoot(dir, key, type, node.uuid, node)

            if (isNewObjectId) await adjustLength(dir, 1)

            return
        }

        const nodes = await insertNode(
            dir,
            existing.uuid,
            entry
        )

        if (nodes.length === 2) {
            const parent = update({
                uuid: newId(),
                indexes: nodes.map(ref)
            })

            await setNode(dir, parent)
            await setRoot(dir, key, type, parent.uuid, parent)
        } else {
            await setRoot(dir, key, type, nodes[0].uuid, nodes[0])
        }

        if (isNewObjectId) await adjustLength(dir, 1)
    }

    const remove = async (
        database,
        array,
        key,
        value,
        objectId,
        stored
    ) => {
        const type = stored?.type ?? typeOf(value)

        if (!type) return false

        const dir = address(database, array)
        const indexedValue = stored?.indexed ?? normalizedValue(value, type)
        const existing = await root(dir, key, type)

        if (!existing) return false

        const result = await removeNode(
            dir,
            existing.uuid,
            [indexedValue, objectId]
        )

        if (!result.removed) return false

        let node = result.node

        while (node?.indexes?.length === 1) {
            const old = node

            node = await getNode(
                dir,
                node.indexes[0].uuid
            )

            await deleteNode(dir, old.uuid)
        }

        await setRoot(dir, key, type, node?.uuid, node)

        indexedValues.delete(indexedValueId(dir, key, objectId, type, indexedValue))

        if (key === '_id') await adjustLength(dir, -1)

        return true
    }

    const scanNode = async function* (
        dir,
        node,
        reverse,
        range
    ) {
        if (node.entries) {
            const entries = node.entries
            // Binary seeking is valid within a homogeneous ordered branch.
            // Retain filtering below for callers supplying cross-type bounds.
            const start = range.lower !== undefined && entries.length && typeof range.lower === typeof entries[0][0]
                ? lowerBound(entries, range.lower, range.lowerOpen) : 0
            const end = range.upper !== undefined && entries.length && typeof range.upper === typeof entries[0][0]
                ? lowerBound(entries, range.upper, !range.upperOpen) : entries.length
            for (let i = reverse ? end - 1 : start; reverse ? i >= start : i < end; i += reverse ? -1 : 1) {
                const entry = entries[i]
                const value = entry[0]
                if (range.lower !== undefined && (
                    value < range.lower || (range.lowerOpen && value === range.lower)
                )) continue
                if (range.upper !== undefined && (
                    value > range.upper || (range.upperOpen && value === range.upper)
                )) continue
                yield entry
            }
        } else {
            const children = node.indexes
            const start = range.lower !== undefined && children.length && typeof range.lower === typeof children[0].firstValue
                ? lowerBound(children, range.lower, range.lowerOpen, 'lastValue') : 0
            const end = range.upper !== undefined && children.length && typeof range.upper === typeof children[0].firstValue
                ? lowerBound(children, range.upper, !range.upperOpen, 'firstValue') : children.length
            for (let i = reverse ? end - 1 : start; reverse ? i >= start : i < end; i += reverse ? -1 : 1) {
                const child = children[i]
                if (range.lower !== undefined && (
                    child.lastValue < range.lower || (range.lowerOpen && child.lastValue === range.lower)
                )) continue
                if (range.upper !== undefined && (
                    child.firstValue > range.upper || (range.upperOpen && child.firstValue === range.upper)
                )) continue
                yield* scanNode(
                    dir,
                    await getNode(dir, child.uuid),
                    reverse,
                    range
                )
            }
        }
    }

    const scan = async function* (
        database,
        array,
        key = '_id',
        {
            type,
            reverse = false,
            limit = Infinity,
            lower,
            upper,
            lowerOpen = false,
            upperOpen = false,
            rootId
        } = {}
    ) {
        const dir = address(database, array)

        const types = type
            ? [type]
            : ['array', 'boolean', 'null', 'number', 'object', 'string', 'undefined']

        if (reverse)
            types.reverse()

        let emitted = 0

        const scanRange = currentType => ({
            lower: lower === undefined ? undefined : normalizedValue(lower, currentType),
            upper: upper === undefined ? undefined : normalizedValue(upper, currentType),
            lowerOpen,
            upperOpen
        })

        for (const currentType of types) {
            const id = rootId ?? await getCatalogRoot(dir, key, currentType)

            if (!id) continue

            const node = await getNode(dir, id)

            for await (const group of scanNode(dir, node, reverse, scanRange(currentType))) {
                const ids = group[1]
                for (let i = reverse ? ids.length - 1 : 0; reverse ? i >= 0 : i < ids.length; i += reverse ? -1 : 1) {
                    if (emitted++ >= limit) return
                    const objectId = ids[i]
                    yield {
                        value: currentType === 'array' || currentType === 'object'
                            ? await readIndexed(dir, database, array, key, objectId, currentType, group[0])
                            : currentType === 'undefined' ? undefined : group[0],
                        objectId
                    }
                }
            }
        }
    }

    const locatePartition = async (database, array, key, value, objectId, nodes, stored) => {
        const type = stored?.type ?? typeOf(value)
        if (!type) return undefined

        const dir = address(database, array)
        const indexedValue = stored?.indexed ?? normalizedValue(value, type)
        const rootId = (await getCatalogEntry(dir, key, type, nodes))?.[2]
        const read = id => readLookupNode(nodeFile(dir, id), () => getNode(dir, id), nodes)
        let node = rootId ? await read(rootId) : undefined
        if (!node) return undefined

        const entry = [indexedValue, objectId]
        while (node) {
            if (node.entries) {
                const at = lowerBound(node.entries, entry[0], false)
                const group = node.entries[at]
                if (!group || compare(group[0], entry[0]) !== 0) return undefined
                const uuidAt = lowerBoundUuid(group[1], objectId)
                if (group[1][uuidAt] !== objectId) return undefined
                return partitionPath(nodeFile(dir, node.uuid))
            }
            node = await read(node.indexes[chooseChild(node.indexes, entry)].uuid)
        }
        return undefined
    }

    const batch = async operation => {
        if (catalogBatch) return operation()
        const current = catalogBatch = { roots: new Map(), lengths: Object.create(null) }
        let result, failure
        try { result = await operation() }
        catch (error) { failure = error }
        catalogBatch = undefined
        try {
            for (const keys of current.roots.values())
                for (const types of keys.values())
                    for (const update of types.values())
                        await setCatalogRoot(update.dir, update.key, update.type, update.rootId, update.rootNode)
            for (const [dir, delta] of Object.entries(current.lengths))
                if (delta) await adjustLength(dir, delta)
        } catch (error) { failure ??= error }
        if (failure) throw failure
        return result
    }

    return {
        artifacts,
        batch,
        catalogId: (database, array) => catalogRootId(address(database, array)),
        async ensureCatalog(database, array) {
            const dir = address(database, array)
            return setCatalogNode(dir, await getCatalogNode(dir, catalogRootId(dir)))
        },
        getMetadata,
        async drop(database, array) {
            const dir = address(database, array)
            const visited = new Set()
            const remove = async (id, key, type) => {
                if (visited.has(id)) return
                visited.add(id)
                const file = nodeFile(dir, id)
                const node = id === catalogRootId(dir)
                    ? await getCatalogNode(dir, id)
                    : await getNode(dir, id)
                for (const child of node?.indexes ?? []) await remove(child.uuid, key, type)
                if (node?.kind === 'catalog') for (const entry of node.entries ?? []) await remove(entry[2], entry[0], entry[1])
                else if (type === 'array' || type === 'object') for (const [digest, uuids] of node?.entries ?? [])
                    for (const uuid of uuids) indexedValues.delete(indexedValueId(dir, key, uuid, type, digest))
                await deleteNode(dir, id)
            }
            await remove(catalogRootId(dir))
        },

        // Logical access: database + array + key.

        read: async (
            database,
            array,
            key = '_id'
        ) => {
            const dir = address(database, array)
            const indexes = {}

            for (const type of ['array', 'boolean', 'null', 'number', 'object', 'string', 'undefined']) {
                const id = await getCatalogRoot(dir, key, type)
                if (id) indexes[type] = await getNode(dir, id)
            }

            return {
                database,
                array,
                key,
                indexes
            }
        },

        // Insert one key/value/objectId index entry. Update currently uses the
        // same insertion behavior; remove an old value with delete() first.

        create: insert,
        update: insert,

        delete: remove,
        removeIndexed: (database, array, entry, objectId) => remove(database, array, entry.key, entry.value, objectId, entry),

        locatePartition,
        locateIndexedPartitions: async (database, array, entries, objectId) => {
            const nodes = new Map(), paths = new Set()
            for (const entry of entries) {
                if (entry.key === '_id') continue
                const path = await locatePartition(database, array, entry.key, entry.value, objectId, nodes, entry)
                if (path) paths.add(path)
            }
            return paths
        },

        // Memoize addresses during a lookup; values remain live cached nodes.
        locatePartitions: async (database, array, entries, objectId) => {
            const nodes = new Map()
            const paths = new Set()
            for (const [key, value] of entries) {
                const path = await locatePartition(database, array, key, value, objectId, nodes)
                if (path) paths.add(path)
            }
            return paths
        },

        scan,

        readPartition: async path => {
            const file = resolvePartitionFile(path)
            return readJSON(file)
        },

        applyPartition: async (path, value) => {
            const file = resolvePartitionFile(path)
            if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.uuid !== 'string')
                throw new TypeError('Index partition must be a JSON index node')
            const expectedId = !flat && path.split('/').at(-1) === 'index.json' ? 'root' : path.split('/').at(-1).slice(0, -5)
            if (value.uuid !== expectedId)
                throw new Error('Index partition ID does not match its path')
            return writeJSON(file, value, { notify: false })
        },

        removePartition: async path => {
            const file = resolvePartitionFile(path)
            cache?.delete(file)
            removeMemoryPath(file)
            artifacts?.delete(artifactId(file))
            if (deleteArtifact) await deleteArtifact(artifactId(file))
            else await rm(file, { force: true })
        },

        // Lower-level node access stays internal
        // to the implementation.

        clearCache: () => { cache?.clear(); parents.clear(); remembered = new WeakSet() }
    }
}


export default createIndex
