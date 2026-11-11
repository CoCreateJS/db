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
 * Index values: finite numbers, strings, booleans, and explicit nulls.
 */
import { link, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { uuid } from '@cocreate/utils'

const clone = value => structuredClone(value)
const newId = () => uuid().replaceAll('-', '')
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0
const compareEntry = (a, b) => compare(a[0], b[0]) || compare(a[1], b[1])
const boundary = entry => ({ value: entry[0], objectId: entry[1] })
const tuple = item => [item.value, item.objectId]
const typeOf = value => value === null ? 'null' :
    typeof value === 'boolean' ? 'boolean' :
        typeof value === 'string' ? 'string' :
            typeof value === 'number' && Number.isFinite(value) ? 'number' : null

export function createIndex({
    directory = './indexes',
    maxBytes = 128 * 1024,
    cache: cacheEnabled = false,
    resolveArrayDirectory,
    indexDirectoryName = 'index'
} = {}) {
    if (maxBytes < 512) throw new Error('maxBytes must be at least 512')
    if (typeof indexDirectoryName !== 'string' || !indexDirectoryName || indexDirectoryName === '.' || indexDirectoryName === '..' || /[\\/\0]/.test(indexDirectoryName))
        throw new TypeError('indexDirectoryName must be a safe directory name')
    const base = resolve(directory)
    const cache = cacheEnabled ? new Map() : null

    const address = (database, array) => {
        for (const part of [database, array]) {
            if (typeof part !== 'string' || !part || part === '.' || part === '..' || /[\\/\0]/.test(part))
                throw new Error('Invalid database or array name')
        }
        if (!resolveArrayDirectory)
            return join(base, encodeURIComponent(database), encodeURIComponent(array))

        const customDirectory = resolve(resolveArrayDirectory({
            directory: base,
            database,
            array
        }))
        const relativeDirectory = relative(base, customDirectory)

        if (isAbsolute(relativeDirectory) || relativeDirectory === '..' || relativeDirectory.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
            throw new Error('Resolved array directory must stay inside the configured directory')

        return customDirectory
    }

    const indexDirectory = dir => join(dir, indexDirectoryName)
    const catalogFile = dir => join(indexDirectory(dir), 'index.json')
    const nodeFile = (dir, id) => join(indexDirectory(dir), `${id}.json`)
    const catalogRootId = 'root'

    const readJSON = async file => {
        if (cache?.has(file)) return clone(cache.get(file))

        let value

        try {
            value = JSON.parse(await readFile(file, 'utf8'))
        } catch (error) {
            if (error.code === 'ENOENT') return undefined
            throw error
        }

        cache?.set(file, value)
        return clone(value)
    }

    const writeJSON = async (file, value) => {
        await mkdir(join(file, '..'), { recursive: true })

        const temp = `${file}.${randomUUID()}.tmp`

        await writeFile(temp, JSON.stringify(value))
        await rename(temp, file)

        cache?.set(file, clone(value))
    }

    const getNode = (dir, id) => readJSON(nodeFile(dir, id))
    const setNode = (dir, node) => writeJSON(nodeFile(dir, node.id), node)

    const catalogNodeFile = (dir, id) => id === catalogRootId ? catalogFile(dir) : nodeFile(dir, id)
    const getCatalogNode = async (dir, id) => {
        let node = await readJSON(catalogNodeFile(dir, id))

        if (!node && id === catalogRootId)
            return { id, kind: 'catalog', count: 0, catalogCount: 0, entries: [] }

        if (id === catalogRootId && node.keys) {
            const entries = []
            for (const [key, branches] of Object.entries(node.keys))
                for (const [type, rootId] of Object.entries(branches))
                    entries.push([key, type, rootId])
            entries.sort((a, b) => compare(a[0], b[0]) || compare(a[1], b[1]))
            node = updateCatalogNode({ id, kind: 'catalog', count: node.count ?? 0, entries })
        }

        return node
    }
    const setCatalogNode = (dir, node) => writeJSON(catalogNodeFile(dir, node.id), node)
    const deleteCatalogNode = async (dir, id) => {
        if (id !== catalogRootId) await deleteNode(dir, id)
    }

    const deleteNode = async (dir, id) => {
        const file = nodeFile(dir, id)

        cache?.delete(file)
        await rm(file, { force: true })
    }

    const size = node => Buffer.byteLength(JSON.stringify(node))

    const ref = node => ({
        id: node.id,
        count: node.count,
        first: node.first,
        last: node.last
    })

    const update = node => {
        const items = node.entries ?? node.indexes

        node.count = node.entries
            ? items.length
            : items.reduce((n, item) => n + item.count, 0)

        node.first = items.length
            ? node.entries
                ? boundary(items[0])
                : items[0].first
            : null

        node.last = items.length
            ? node.entries
                ? boundary(items.at(-1))
                : items.at(-1).last
            : null

        return node
    }

    const compareCatalogKey = (a, b) => compare(a[0], b[0]) || compare(a[1], b[1])
    const catalogBoundary = entry => [entry[0], entry[1]]
    const catalogRef = node => ({
        id: node.id,
        count: node.catalogCount,
        first: node.first,
        last: node.last
    })
    const updateCatalogNode = node => {
        const items = node.entries ?? node.indexes
        node.catalogCount = node.entries
            ? items.length
            : items.reduce((count, item) => count + item.count, 0)
        node.first = items.length
            ? node.entries ? catalogBoundary(items[0]) : items[0].first
            : null
        node.last = items.length
            ? node.entries ? catalogBoundary(items.at(-1)) : items.at(-1).last
            : null
        return node
    }

    const splitCatalogNode = node => {
        const property = node.entries ? 'entries' : 'indexes'
        const items = node[property]
        const weights = items.map(item => Buffer.byteLength(JSON.stringify(item)) + 1)
        const half = weights.reduce((a, b) => a + b, 0) / 2
        let total = 0
        let at = 1

        for (let i = 0; i < items.length - 1; i++) {
            total += weights[i]
            at = i + 1
            if (total >= half) break
        }

        const sibling = { id: newId(), kind: 'catalog', [property]: items.splice(at) }
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

            if (compareEntry(tuple(children[mid].last), entry) < 0)
                lo = mid + 1
            else
                hi = mid
        }

        return Math.min(lo, children.length - 1)
    }

    const split = node => {
        const property = node.entries ? 'entries' : 'indexes'
        const items = node[property]

        // Prefer a near-even byte split;
        // estimate each entry's serialized weight.

        const weights = items.map(
            item => Buffer.byteLength(JSON.stringify(item)) + 1
        )

        const half = weights.reduce((a, b) => a + b, 0) / 2

        let total = 0
        let at = 1

        for (let i = 0; i < items.length - 1; i++) {
            total += weights[i]
            at = i + 1

            if (total >= half) break
        }

        const sibling = {
            id: newId(),
            [property]: items.splice(at)
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
            const at = findPosition(node.entries, entry, compareEntry)

            if (
                at === node.entries.length ||
                compareEntry(node.entries[at], entry) !== 0
            ) {
                node.entries.splice(at, 0, entry)
            }
        } else {
            const at = chooseChild(node.indexes, entry)

            const children = await insertNode(
                dir,
                node.indexes[at].id,
                entry
            )

            node.indexes.splice(
                at,
                1,
                ...children.map(ref)
            )
        }

        update(node)

        if (size(node) <= maxBytes) {
            await setNode(dir, node)
            return [node]
        }

        if ((node.entries ?? node.indexes).length < 2)
            throw new Error('Single index entry exceeds maximum index size')

        const sibling = split(node)

        if (
            size(node) > maxBytes ||
            size(sibling) > maxBytes
        ) {
            throw new Error('Cannot fit index node under maximum size')
        }

        await setNode(dir, node)
        await setNode(dir, sibling)

        return [node, sibling]
    }

    const removeNode = async (dir, id, entry) => {
        const node = await getNode(dir, id)

        if (!node)
            throw new Error(`Missing index node ${id}`)

        if (node.entries) {
            const at = findPosition(node.entries, entry, compareEntry)

            if (
                at >= node.entries.length ||
                compareEntry(node.entries[at], entry)
            ) {
                return { node, removed: false }
            }

            node.entries.splice(at, 1)
        } else {
            const at = chooseChild(node.indexes, entry)

            const result = await removeNode(
                dir,
                node.indexes[at].id,
                entry
            )

            if (!result.removed)
                return { node, removed: false }

            if (result.node)
                node.indexes[at] = ref(result.node)
            else
                node.indexes.splice(at, 1)
        }

        update(node)

        if (!node.count) {
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
            if (compareCatalogKey(children[mid].last, entry) < 0) lo = mid + 1
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
                node.entries[at][2] = entry[2]
            else
                node.entries.splice(at, 0, entry)
        } else {
            const at = chooseCatalogChild(node.indexes, catalogBoundary(entry))
            const children = await insertCatalogNode(dir, node.indexes[at].id, entry)
            node.indexes.splice(at, 1, ...children.map(catalogRef))
        }

        updateCatalogNode(node)

        if (size(node) <= maxBytes) {
            await setCatalogNode(dir, node)
            return [node]
        }

        if ((node.entries ?? node.indexes).length < 2)
            throw new Error('Single catalog entry exceeds maximum index size')

        const sibling = splitCatalogNode(node)

        if (size(node) > maxBytes || size(sibling) > maxBytes)
            throw new Error('Cannot fit catalog node under maximum index size')

        if (id === catalogRootId) {
            const left = { ...node, id: newId() }
            await setCatalogNode(dir, left)
            await setCatalogNode(dir, sibling)
            const root = updateCatalogNode({
                id: catalogRootId,
                kind: 'catalog',
                count: node.count ?? 0,
                indexes: [catalogRef(left), catalogRef(sibling)]
            })
            if (size(root) > maxBytes)
                throw new Error('Catalog root references exceed maximum index size')
            await setCatalogNode(dir, root)
            return [root]
        }

        await setCatalogNode(dir, node)
        await setCatalogNode(dir, sibling)
        return [node, sibling]
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
            const result = await removeCatalogNode(dir, node.indexes[at].id, key)
            if (!result.removed) return { node, removed: false }
            if (result.node) node.indexes[at] = catalogRef(result.node)
            else node.indexes.splice(at, 1)
        }

        updateCatalogNode(node)

        if (!node.catalogCount && id !== catalogRootId) {
            await deleteCatalogNode(dir, id)
            return { node: null, removed: true }
        }

        await setCatalogNode(dir, node)
        return { node, removed: true }
    }

    const setCatalogRoot = async (dir, key, type, rootId) => {
        const entryKey = [key, type]
        const existing = await getCatalogRoot(dir, key, type)

        if (rootId) {
            await insertCatalogNode(dir, catalogRootId, [key, type, rootId])
            return
        }

        if (!existing) return
        await removeCatalogNode(dir, catalogRootId, entryKey)

        let current = await getCatalogNode(dir, catalogRootId)
        while (current.indexes?.length === 1) {
            const child = await getCatalogNode(dir, current.indexes[0].id)
            const objectCount = current.count ?? 0
            await deleteCatalogNode(dir, child.id)
            current = { ...child, id: catalogRootId, kind: 'catalog', count: objectCount }
            await setCatalogNode(dir, current)
        }

        // Keep a stable empty root after the last catalog entry is removed.
        if (!current.catalogCount && !current.entries)
            await setCatalogNode(dir, updateCatalogNode({
                id: catalogRootId,
                kind: 'catalog',
                count: current.count ?? 0,
                entries: []
            }))
    }

    const getCatalogRoot = async (dir, key, type) => {
        const entry = [key, type]
        let node = await getCatalogNode(dir, catalogRootId)

        while (node) {
            if (node.entries) {
                const at = findPosition(node.entries, entry, compareCatalogKey)
                return at < node.entries.length && compareCatalogKey(catalogBoundary(node.entries[at]), entry) === 0
                    ? node.entries[at][2]
                    : undefined
            }
            node = await getCatalogNode(dir, node.indexes[chooseCatalogChild(node.indexes, entry)].id)
        }
    }

    const splitCatalogRoot = async (dir, root) => {
        if ((root.entries ?? root.indexes).length < 2)
            throw new Error('Catalog root metadata exceeds maximum index size')

        const sibling = splitCatalogNode(root)
        const left = { ...root, id: newId() }
        await setCatalogNode(dir, left)
        await setCatalogNode(dir, sibling)

        const nextRoot = updateCatalogNode({
            id: catalogRootId,
            kind: 'catalog',
            count: root.count ?? 0,
            indexes: [catalogRef(left), catalogRef(sibling)]
        })

        if (size(nextRoot) > maxBytes)
            throw new Error('Catalog root references exceed maximum index size')

        await setCatalogNode(dir, nextRoot)
        return nextRoot
    }

    const adjustCount = async (dir, delta) => {
        const root = await getCatalogNode(dir, catalogRootId)
        const currentCount = Number.isSafeInteger(root.count) && root.count >= 0
            ? root.count
            : 0
        root.count = Math.max(0, currentCount + delta)

        if (size(root) > maxBytes) {
            await splitCatalogRoot(dir, root)
            return
        }

        await setCatalogNode(dir, root)
    }

    const containsNode = async (dir, id, entry) => {
        const node = await getNode(dir, id)

        if (!node)
            throw new Error(`Missing index node ${id}`)

        if (node.entries) {
            const at = findPosition(node.entries, entry, compareEntry)
            return at < node.entries.length && compareEntry(node.entries[at], entry) === 0
        }

        const at = chooseChild(node.indexes, entry)
        return containsNode(dir, node.indexes[at].id, entry)
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
                'Only finite numbers, strings, booleans, and null are indexed in this prototype'
            )

        if (typeof objectId !== 'string')
            throw new TypeError('objectId must be a string')

        const dir = address(database, array)
        const existing = await root(dir, key, type)

        const entry = [value, objectId]
        const isNewObjectId = key === '_id' && (!existing || !await containsNode(dir, existing.id, entry))

        if (!existing) {
            const node = update({
                id: newId(),
                entries: [entry]
            })

            await setNode(dir, node)
            await setRoot(dir, key, type, node.id)

            if (isNewObjectId) await adjustCount(dir, 1)

            return
        }

        const nodes = await insertNode(
            dir,
            existing.id,
            entry
        )

        if (nodes.length === 2) {
            const parent = update({
                id: newId(),
                indexes: nodes.map(ref)
            })

            await setNode(dir, parent)
            await setRoot(dir, key, type, parent.id)
        }

        if (isNewObjectId) await adjustCount(dir, 1)
    }

    const remove = async (
        database,
        array,
        key,
        value,
        objectId
    ) => {
        const type = typeOf(value)

        if (!type) return false

        const dir = address(database, array)
        const existing = await root(dir, key, type)

        if (!existing) return false

        const result = await removeNode(
            dir,
            existing.id,
            [value, objectId]
        )

        if (!result.removed) return false

        let node = result.node

        while (node?.indexes?.length === 1) {
            const old = node

            node = await getNode(
                dir,
                node.indexes[0].id
            )

            await deleteNode(dir, old.id)
        }

        if (node?.id !== existing.id)
            await setRoot(dir, key, type, node?.id)

        if (key === '_id') await adjustCount(dir, -1)

        return true
    }

    const scanNode = async function* (
        dir,
        node,
        reverse,
        range
    ) {
        if (node.entries) {
            const entries = reverse
                ? [...node.entries].reverse()
                : node.entries

            for (const entry of entries) {
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
            const children = reverse
                ? [...node.indexes].reverse()
                : node.indexes

            for (const child of children) {
                if (range.lower !== undefined && (
                    child.last.value < range.lower || (range.lowerOpen && child.last.value === range.lower)
                )) continue
                if (range.upper !== undefined && (
                    child.first.value > range.upper || (range.upperOpen && child.first.value === range.upper)
                )) continue
                yield* scanNode(
                    dir,
                    await getNode(dir, child.id),
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
            upperOpen = false
        } = {}
    ) {
        const dir = address(database, array)

        const types = type
            ? [type]
            : ['boolean', 'null', 'number', 'string']

        if (reverse)
            types.reverse()

        let emitted = 0

        for (const currentType of types) {
            const id = await getCatalogRoot(dir, key, currentType)

            if (!id) continue

            const node = await getNode(dir, id)

            for await (
                const entry of scanNode(dir, node, reverse, { lower, upper, lowerOpen, upperOpen })
            ) {
                if (emitted++ >= limit) return

                yield {
                    value: entry[0],
                    objectId: entry[1]
                }
            }
        }
    }

    return {
        // Logical access: database + array + key.

        get: async (
            database,
            array,
            key = '_id'
        ) => {
            const dir = address(database, array)
            const indexes = {}

            for (const type of ['boolean', 'null', 'number', 'string']) {
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

        // Set one key/value/objectId index entry.
        // Use remove() for an old value first.

        set: insert,

        remove,

        scan,

        // Lower-level node access stays internal
        // to the implementation.

        clearCache: () => cache?.clear()
    }
}


export default createIndex
