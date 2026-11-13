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
 * Index values: finite numbers, strings, booleans, explicit nulls, and terminal arrays.
 */
import { mkdir, readdir, rm, unlink } from '../io.js'
import { replaceJSON } from '../storage.js'
import { createHash } from 'node:crypto'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { uuid } from '@cocreate/utils'
import { arrayDigest } from '../entries.js'
import { live } from '../mutation.js'
import { registerPartition } from '../partition.js'
import { readMemoryJSON, removeMemoryPath, memoryEnabled, memoryOnly } from '../memory.js'

const newId = () => uuid().replaceAll('-', '')
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0
const compareEntry = (a, b) => compare(a[0], b[0]) || compare(a[1], b[1])
const boundary = entry => ({ value: entry[0], objectId: entry[1] })
const tuple = item => [item.value, item.objectId]
const typeOf = value => value === null ? 'null' :
    Array.isArray(value) ? 'array' :
    typeof value === 'boolean' ? 'boolean' :
        typeof value === 'string' ? 'string' :
            typeof value === 'number' && Number.isFinite(value) ? 'number' : null

export function createIndex({
    directory = './indexes',
    maxBytes = 128 * 1024,
    cache: cacheEnabled = false,
    resolveArrayDirectory,
    indexDirectoryName = 'index',
    onPartitionChange,
    readPartition
} = {}) {
    if (maxBytes < 512) throw new Error('maxBytes must be at least 512')
    if (typeof indexDirectoryName !== 'string' || !indexDirectoryName || indexDirectoryName === '.' || indexDirectoryName === '..' || /[\\/\0]/.test(indexDirectoryName))
        throw new TypeError('indexDirectoryName must be a safe directory name')
    const base = resolve(directory)
    const cache = cacheEnabled ? new Map() : null
    const arrayValues = new Map()
    const reportedPartitions = new Set()
    const parents = new Map()
    let remembered = new WeakSet()
    let changedPartitions
    const remember = (file, node, changed = false) => {
        if (!node || (!changed && remembered.has(node))) return node
        remembered.add(node)
        const dir = join(file, '..', '..')
        for (const child of node.indexes ?? []) parents.set(nodeFile(dir, child.id), file)
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
    const arrayValueDirectory = (dir, key, objectId, digest) => join(
        indexDirectory(dir),
        'values',
        createHash('sha256').update(key).digest('hex'),
        `${createHash('sha256').update(objectId).digest('hex')}-${digest}`
    )
    const normalizedValue = (value, type = typeOf(value)) => type === 'array' ? arrayDigest(value) : value

    const writeArrayValue = async (dir, key, value, objectId, digest) => {
        const directory = arrayValueDirectory(dir, key, objectId, digest)
        if (cacheEnabled || memoryEnabled(directory)) arrayValues.set(directory, live(value))
        if (memoryOnly(directory)) return
        await mkdir(directory, { recursive: true })
        // A terminal value is whole data, not a structurally split index node.
        await replaceJSON(join(directory, 'value.json'), value)
        for (const file of await readdir(directory))
            if (/^\d+\.json$/.test(file)) await unlink(join(directory, file))
    }

    const readArrayValue = async (dir, key, objectId, digest) => {
        const directory = arrayValueDirectory(dir, key, objectId, digest)
        if (arrayValues.has(directory)) return arrayValues.get(directory)
        try {
            const whole = await readMemoryJSON(join(directory, 'value.json'))
            if (whole !== undefined) {
                if (!Array.isArray(whole)) throw new Error(`Invalid indexed array value for ${key}/${objectId}`)
                if (cacheEnabled || memoryEnabled(directory)) arrayValues.set(directory, live(whole))
                return live(whole)
            }
            // Legacy bounded array encodings remain readable.
            const files = (await readdir(directory)).filter(file => file.endsWith('.json')).sort()
            const chunks = []
            let total
            for (const file of files) {
                const envelope = await readMemoryJSON(join(directory, file))
                if (!Number.isSafeInteger(envelope.index) || !Number.isSafeInteger(envelope.total) ||
                    typeof envelope.chunk !== 'string' || envelope.index !== chunks.length ||
                    (total !== undefined && envelope.total !== total))
                    throw new Error(`Corrupt indexed array value for ${key}/${objectId}`)
                total = envelope.total
                chunks.push(envelope.chunk)
            }
            if (!total || chunks.length !== total)
                throw new Error(`Incomplete indexed array value for ${key}/${objectId}`)
            const value = JSON.parse(chunks.join(''))
            if (cacheEnabled || memoryEnabled(directory)) arrayValues.set(directory, value)
            return value
        } catch (error) {
            if (error.code === 'ENOENT')
                throw new Error(`Missing indexed array value for ${key}/${objectId}`)
            throw error
        }
    }
    const catalogRootId = 'root'

    const partitionPath = file => relative(base, file).split(/[\\/]/).join('/')

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

    const readJSON = async file => {
        if (cache?.has(file)) {
            const value = live(cache.get(file))
            await reportLocalPartition(file, value)
            return remember(file, live(value))
        }

        let value

        value = await readMemoryJSON(file)
        if (value === undefined) {
            if (!readPartition) return undefined
            value = await readPartition(partitionPath(file))
            if (value === undefined) return undefined
            await writeJSON(file, value, { acquired: true })
            return live(value)
        }

        // Both cache layers retain the same live node.
        cache?.set(file, live(value))
        await reportLocalPartition(file, value)
        return remember(file, value)
    }

    const writeJSON = async (file, value, { acquired = false, notify = true } = {}) => {
        value = await replaceJSON(file, value)
        cache?.set(file, live(value))
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

    const normalizeLengths = node => {
        if (!node) return node
        if (node.length === undefined && node.count !== undefined) node.length = node.count
        if (node.catalogLength === undefined && node.catalogCount !== undefined)
            node.catalogLength = node.catalogCount
        delete node.count
        delete node.catalogCount
        for (const child of node.indexes ?? []) normalizeLengths(child)
        return node
    }
    const getNode = async (dir, id) => normalizeLengths(await readJSON(nodeFile(dir, id)))
    const setNode = (dir, node) => writeJSON(nodeFile(dir, node.id), node)

    const catalogNodeFile = (dir, id) => id === catalogRootId ? catalogFile(dir) : nodeFile(dir, id)
    const getCatalogNode = async (dir, id) => {
        let node = normalizeLengths(await readJSON(catalogNodeFile(dir, id)))

        if (!node && id === catalogRootId)
            return { id, kind: 'catalog', length: 0, catalogLength: 0, entries: [] }

        if (id === catalogRootId && node.keys) {
            const entries = []
            for (const [key, branches] of Object.entries(node.keys))
                for (const [type, rootId] of Object.entries(branches))
                    entries.push([key, type, rootId])
            entries.sort((a, b) => compare(a[0], b[0]) || compare(a[1], b[1]))
            node = updateCatalogNode({ id, kind: 'catalog', length: node.length ?? 0, entries })
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
        removeMemoryPath(file)
        reportedPartitions.delete(file)
        parents.delete(file)
        await rm(file, { force: true })
        if (onPartitionChange)
            await onPartitionChange({ path: partitionPath(file), operation: 'remove' })
    }

    const validPartitionPath = path => {
        if (typeof path !== 'string' || !path || path.includes('\\') || path.includes('\0')) return false
        const parts = path.split('/')
        if (parts.some(part => !part || part === '.' || part === '..')) return false
        const indexAt = parts.lastIndexOf('index')
        if (indexAt < 0 || indexAt === parts.length - 1 || parts.includes('values') || parts.includes('distribution')) return false
        const file = parts.at(-1)
        return file === 'index.json' || /^[a-f0-9]{32}\.json$/i.test(file)
    }

    const resolvePartitionFile = path => {
        if (!validPartitionPath(path)) throw new TypeError('Invalid index partition path')
        const file = resolve(base, path)
        const withinBase = relative(base, file)
        if (!withinBase || withinBase === '..' || withinBase.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(withinBase))
            throw new TypeError('Index partition path must stay inside the configured directory')
        return file
    }


    const ref = node => ({
        id: node.id,
        length: node.length,
        first: live(node.first),
        last: live(node.last)
    })

    const update = node => {
        const items = node.entries ?? node.indexes

        node.length = node.entries
            ? items.length
            : items.reduce((n, item) => n + item.length, 0)

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
        length: node.catalogLength,
        first: live(node.first),
        last: live(node.last)
    })
    const updateCatalogNode = node => {
        const items = node.entries ?? node.indexes
        node.catalogLength = node.entries
            ? items.length
            : items.reduce((length, item) => length + item.length, 0)
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
        const at = Math.ceil(items.length / 2);

        const moved = items.splice(at)
        for (let i = 0; i < moved.length; i++) moved[i] = live(moved[i])
        const sibling = { id: newId(), kind: 'catalog', [property]: moved }
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

        const at = Math.ceil(items.length / 2);

        const moved = items.splice(at)
        for (let i = 0; i < moved.length; i++) moved[i] = live(moved[i])
        const sibling = {
            id: newId(),
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

        await setNode(dir, node)
        return [node]
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
                node.entries[at] = entry
            else
                node.entries.splice(at, 0, entry)
        } else {
            const at = chooseCatalogChild(node.indexes, catalogBoundary(entry))
            const children = await insertCatalogNode(dir, node.indexes[at].id, entry)
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
            const result = await removeCatalogNode(dir, node.indexes[at].id, key)
            if (!result.removed) return { node, removed: false }
            if (result.node) node.indexes[at] = catalogRef(result.node)
            else node.indexes.splice(at, 1)
        }

        updateCatalogNode(node)

        if (!node.catalogLength && id !== catalogRootId) {
            await deleteCatalogNode(dir, id)
            return { node: null, removed: true }
        }

        await setCatalogNode(dir, node)
        return { node, removed: true }
    }

    const setCatalogRoot = async (dir, key, type, rootId, rootNode) => {
        const entryKey = [key, type]
        if (rootId) {
            const node = rootNode ?? await getNode(dir, rootId)
            await insertCatalogNode(dir, catalogRootId, [key, type, rootId, {
                length: node.length, first: live(node.first), last: live(node.last)
            }])
            return
        }

        if (!await getCatalogRoot(dir, key, type)) return
        await removeCatalogNode(dir, catalogRootId, entryKey)

        let current = await getCatalogNode(dir, catalogRootId)
        while (current.indexes?.length === 1) {
            const child = await getCatalogNode(dir, current.indexes[0].id)
            const objectLength = current.length ?? 0
            await deleteCatalogNode(dir, child.id)
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
                id: catalogRootId,
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
        const read = id => readLookupNode(catalogNodeFile(dir, id), () => getCatalogNode(dir, id), nodes)
        const entry = [key, type]
        let node = await read(catalogRootId)

        while (node) {
            if (node.entries) {
                const at = findPosition(node.entries, entry, compareCatalogKey)
                return at < node.entries.length && compareCatalogKey(catalogBoundary(node.entries[at]), entry) === 0
                    ? node.entries[at]
                    : undefined
            }
            node = await read(node.indexes[chooseCatalogChild(node.indexes, entry)].id)
        }
    }

    const getCatalogRoot = async (dir, key, type) =>
        (await getCatalogEntry(dir, key, type))?.[2]

    // Resolve statistics without loading value roots for current catalog entries.
    // Legacy mappings are read lazily and upgraded by the next mutation.
    const getMetadata = async (database, array, key = '_id') => {
        const dir = address(database, array)
        const indexes = {}
        const visit = async node => {
            if (node.entries) {
                for (const entry of node.entries) {
                    if (entry[0] !== key) continue
                    const metadata = entry[3] ?? await getNode(dir, entry[2])
                    if (!metadata) throw new Error(`Missing index node ${entry[2]}`)
                    indexes[entry[1]] = { id: entry[2], length: metadata.length,
                        first: metadata.first, last: metadata.last }
                }
            } else {
                for (const child of node.indexes)
                    if (child.first[0] <= key && child.last[0] >= key)
                        await visit(await getCatalogNode(dir, child.id))
            }
        }
        await visit(await getCatalogNode(dir, catalogRootId))
        return { database, array, key, indexes }
    }

    const liftCatalogRoot = async (dir, root, sibling) => {
        const property = root.entries ? 'entries' : 'indexes'
        const left = updateCatalogNode({ id: newId(), kind: 'catalog', [property]: live(root[property]) })
        await setCatalogNode(dir, left)
        await setCatalogNode(dir, sibling)
        delete root.entries
        root.indexes = [catalogRef(left), catalogRef(sibling)]
        updateCatalogNode(root)
        await setCatalogNode(dir, root)
        return root
    }

    const adjustLength = async (dir, delta) => {
        const root = await getCatalogNode(dir, catalogRootId)
        const currentLength = Number.isSafeInteger(root.length) && root.length >= 0
            ? root.length
            : 0
        root.length = Math.max(0, currentLength + delta)

        await setCatalogNode(dir, root)
    }

    // Register ancestry after a cold direct partition read. Catalogs identify
    // field roots; only a candidate root's ordered path is followed below it.
    const findParent = async (dir, target) => {
        const targetFile = nodeFile(dir, target.id)
        const visitCatalog = async node => {
            if (node.indexes) {
                for (const child of node.indexes) {
                    const found = await visitCatalog(await getCatalogNode(dir, child.id))
                    if (found) return true
                }
            } else if (target.kind !== 'catalog') {
                for (const entry of node.entries) {
                    let current = await getNode(dir, entry[2])
                    while (current) {
                        if (current.id === target.id) return true
                        if (!current.indexes || !target.first) break
                        if (typeof current.first?.value !== typeof target.first.value) break
                        current = await getNode(dir, current.indexes[chooseChild(current.indexes, tuple(target.first))].id)
                    }
                }
            }
            return parents.has(targetFile)
        }
        await visitCatalog(await getCatalogNode(dir, catalogRootId))
    }

    const splitForSend = async (file, node) => {
        // Oversized indivisible values and minimum-fanout nodes are valid.
        if (node.entries ? node.entries.length < 2 : !node.indexes || node.indexes.length < 4) return
        const dir = join(file, '..', '..')
        if (node.id !== catalogRootId && !parents.has(file)) await findParent(dir, node)
        if (node.id !== catalogRootId && !parents.has(file)) return
        const changes = new Map()
        changedPartitions = changes
        try {
            if (node.kind === 'catalog' && node.id === catalogRootId) {
                await liftCatalogRoot(dir, node, splitCatalogNode(node))
            } else {
                const sibling = node.kind === 'catalog' ? splitCatalogNode(node) : split(node)
                await writeJSON(file, node)
                await writeJSON(nodeFile(dir, sibling.id), sibling)
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
                            root = update({ id: newId(), indexes: children.map(ref) })
                            await setNode(dir, root)
                        }
                        entry[2] = root.id
                        entry[3] = { length: root.length, first: live(root.first), last: live(root.last) }
                    } else {
                        const at = parent.indexes.findIndex(child => nodeFile(dir, child.id) === childFile)
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
                'Only finite numbers, strings, booleans, null, and arrays are indexed in this prototype'
            )

        if (typeof objectId !== 'string')
            throw new TypeError('objectId must be a string')

        const dir = address(database, array)
        const indexedValue = normalizedValue(value, type)
        if (type === 'array') await writeArrayValue(dir, key, value, objectId, indexedValue)
        const existing = await root(dir, key, type)

        const entry = [indexedValue, objectId]
        const isNewObjectId = key === '_id' && (!existing || !await containsNode(dir, existing.id, entry))

        if (!existing) {
            const node = update({
                id: newId(),
                entries: [entry]
            })

            await setNode(dir, node)
            await setRoot(dir, key, type, node.id, node)

            if (isNewObjectId) await adjustLength(dir, 1)

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
            await setRoot(dir, key, type, parent.id, parent)
        } else {
            await setRoot(dir, key, type, nodes[0].id, nodes[0])
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
            existing.id,
            [indexedValue, objectId]
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

        await setRoot(dir, key, type, node?.id, node)

        if (type === 'array') {
            arrayValues.delete(arrayValueDirectory(dir, key, objectId, indexedValue))
            await rm(arrayValueDirectory(dir, key, objectId, indexedValue), { recursive: true, force: true }).catch(() => {})
        }

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
            const position = (value, afterEquals) => {
                let lo = 0
                let hi = entries.length
                while (lo < hi) {
                    const mid = (lo + hi) >>> 1
                    if (entries[mid][0] < value || afterEquals && entries[mid][0] === value) lo = mid + 1
                    else hi = mid
                }
                return lo
            }
            // Binary seeking is valid within a homogeneous ordered branch.
            // Retain filtering below for callers supplying cross-type bounds.
            const sameType = value => entries.length && typeof value === typeof entries[0][0]
            const start = range.lower !== undefined && sameType(range.lower)
                ? position(range.lower, range.lowerOpen) : 0
            const end = range.upper !== undefined && sameType(range.upper)
                ? position(range.upper, !range.upperOpen) : entries.length
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
            for (let i = reverse ? children.length - 1 : 0; reverse ? i >= 0 : i < children.length; i += reverse ? -1 : 1) {
                const child = children[i]
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
            : ['array', 'boolean', 'null', 'number', 'string']

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
            const id = await getCatalogRoot(dir, key, currentType)

            if (!id) continue

            const node = await getNode(dir, id)

            for await (
                const entry of scanNode(dir, node, reverse, scanRange(currentType))
            ) {
                if (emitted++ >= limit) return

                yield {
                    value: currentType === 'array'
                        ? await readArrayValue(dir, key, entry[1], entry[0])
                        : entry[0],
                    objectId: entry[1]
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
                const at = findPosition(node.entries, entry, compareEntry)
                if (at >= node.entries.length || compareEntry(node.entries[at], entry) !== 0)
                    return undefined
                return partitionPath(nodeFile(dir, node.id))
            }
            node = await read(node.indexes[chooseChild(node.indexes, entry)].id)
        }
        return undefined
    }

    return {
        getMetadata,

        // Logical access: database + array + key.

        get: async (
            database,
            array,
            key = '_id'
        ) => {
            const dir = address(database, array)
            const indexes = {}

            for (const type of ['array', 'boolean', 'null', 'number', 'string']) {
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
            try {
                return remember(file, await readMemoryJSON(file))
            } catch (error) {
                if (error.code === 'ENOENT') return undefined
                throw error
            }
        },

        applyPartition: async (path, value) => {
            const file = resolvePartitionFile(path)
            if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.id !== 'string')
                throw new TypeError('Index partition must be a JSON index node')
            const expectedId = path.split('/').at(-1) === 'index.json'
                ? 'root'
                : path.split('/').at(-1).slice(0, -5)
            if (value.id !== expectedId)
                throw new Error('Index partition ID does not match its path')
            return writeJSON(file, value, { notify: false })
        },

        removePartition: async path => {
            const file = resolvePartitionFile(path)
            cache?.delete(file)
            removeMemoryPath(file)
            await rm(file, { force: true })
        },

        // Lower-level node access stays internal
        // to the implementation.

        clearCache: () => { cache?.clear(); arrayValues.clear(); parents.clear(); remembered = new WeakSet() }
    }
}


export default createIndex
