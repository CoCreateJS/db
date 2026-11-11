import { queryData, searchData, sortData } from '@cocreate/utils'
import { normalizeQuery } from './query.js'

const clone = value => structuredClone(value)

function readFilter(request) {
    if (request.filter) return request.filter
    if (Array.isArray(request.object)) return request.object.find(item => item?.filter)?.filter
    return request.object?.filter
}

function readPosition(filter, database, array) {
    if (!filter || filter.isFilter === false) return undefined
    if (!Array.isArray(filter.storages)) filter.storages = []

    let metadata = filter.storages.find(item =>
        item.storage === 'db' && item.database === database && item.array === array
    )
    if (!metadata) {
        metadata = { storage: 'db', database, array }
        filter.storages.push(metadata)
    }

    const startingIndex = metadata.index ?? filter.startingIndex ?? filter.index ?? 0
    if (!Number.isSafeInteger(startingIndex) || startingIndex < 0)
        throw new TypeError('filter index must be a non-negative safe integer')
    metadata.startingIndex = startingIndex
    return metadata
}

function copyPath(source, target, keys) {
    if (source === undefined) return target
    if (!keys.length) return clone(source)
    if (Array.isArray(source))
        return source.map((value, index) => copyPath(value, target?.[index], keys))
    if (!source || typeof source !== 'object') return target

    const [key, ...rest] = keys
    if (!Object.hasOwn(source, key)) return target
    const output = target && typeof target === 'object' && !Array.isArray(target) ? target : {}
    output[key] = copyPath(source[key], output[key], rest)
    return output
}

function removePath(target, keys) {
    if (Array.isArray(target)) {
        for (const value of target) removePath(value, keys)
        return
    }
    if (!target || typeof target !== 'object') return
    const [key, ...rest] = keys
    if (!rest.length) delete target[key]
    else removePath(target[key], rest)
}

function project(record, projection) {
    if (!projection || !Object.keys(projection).length) return record

    const entries = Object.entries(projection)
    const includes = entries.filter(([key, value]) => key !== '_id' && Boolean(value))
    const excludes = entries.filter(([key, value]) => !value && key !== '_id')
    const includeId = projection._id === 1 || projection._id === true
    if (includes.length && excludes.length || includeId && excludes.length)
        throw new TypeError('filter.key cannot mix included and excluded fields')

    const isInclusion = includes.length > 0 || includeId
    if (isInclusion) {
        const output = {}
        for (const [key] of includes) {
            const [first, ...rest] = key.replace(/\[(\d+)\]/g, '.$1').split('.')
            const projected = copyPath(record[first], output[first], rest)
            if (projected !== undefined) output[first] = projected
        }
        if ((projection._id !== 0 && projection._id !== false) && record._id !== undefined)
            output._id = clone(record._id)
        return output
    }

    const output = clone(record)
    for (const [key] of excludes)
        removePath(output, key.replace(/\[(\d+)\]/g, '.$1').split('.'))
    if (projection._id === 0 || projection._id === false) delete output._id
    return output
}

function normalizeSort(sort) {
    if (!Array.isArray(sort)) return []
    return sort
        .filter(item => item?.key)
        .map(item => ({
            key: item.key,
            direction: item.direction === 'desc' || item.direction === -1 ? 'desc' : 'asc'
        }))
}

/** Apply the shared CoCreate read filter to one source's candidate records. */
export function applyReadFilter(records, request, { database, array, query = {} }) {
    const filter = readFilter(request)
    const filterQuery = normalizeQuery({ filter: { query: filter?.query } })
    const matches = records.filter(record => queryData(record, query) && queryData(record, filterQuery))
    const count = matches.length
    const storagePosition = readPosition(filter, database, array)
    const sorted = normalizeSort(filter?.sort).length
        ? sortData([...matches], normalizeSort(filter.sort))
        : matches
    const searched = filter?.search ? sorted.filter(record => searchData(record, filter.search)) : sorted
    const startingIndex = storagePosition?.startingIndex ?? filter?.startingIndex ?? filter?.index ?? 0
    const limit = filter?.limit
    const page = searched.slice(startingIndex, limit ? startingIndex + limit : undefined)

    if (storagePosition) {
        storagePosition.count = count
        storagePosition.index = startingIndex + page.length
    }

    return page.map(record => ({
        ...project(record, filter?.key),
        $storage: record.$storage ?? ['db'],
        ...(record.$database ? { $database: record.$database } : {}),
        ...(record.$array ? { $array: record.$array } : {})
    }))
}
