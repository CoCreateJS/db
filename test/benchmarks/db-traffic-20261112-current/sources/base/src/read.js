import { queryData, searchData, sortData } from '@cocreate/utils'
import { normalizeQuery } from './query.js'

import { live } from './mutation.js'

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

function selectPath(source, target, keys) {
    if (source === undefined) return target
    if (!keys.length) return live(source)
    if (Array.isArray(source) && /^\d+$/.test(keys[0])) {
        const index = Number(keys[0])
        const output = Array.isArray(target) ? target : []
        const projected = selectPath(source[index], output[index], keys.slice(1))
        if (projected !== undefined) output[index] = projected
        return output
    }
    if (Array.isArray(source))
        return source.map((value, index) => selectPath(value, target?.[index], keys))
    if (!source || typeof source !== 'object') return target

    const [key, ...rest] = keys
    if (!Object.hasOwn(source, key)) return target
    const output = target && typeof target === 'object' && !Array.isArray(target) ? target : {}
    output[key] = selectPath(source[key], output[key], rest)
    return output
}

// Projection creates only requested view containers; unchanged values stay shared.
function excludeView(value, paths) {
    if (!value || typeof value !== 'object' || !paths.length) return live(value)
    if (Array.isArray(value)) return value.map((item, index) => {
        const selected = paths.filter(path => !/^\d+$/.test(path[0]) || Number(path[0]) === index)
            .map(path => /^\d+$/.test(path[0]) ? path.slice(1) : path)
        return excludeView(item, selected)
    })
    const output = {}
    for (const key of Object.keys(value)) {
        const selected = paths.filter(path => path[0] === key)
        if (selected.some(path => path.length === 1)) continue
        output[key] = selected.length ? excludeView(value[key], selected.map(path => path.slice(1))) : live(value[key])
    }
    return output
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
            const projected = selectPath(record[first], output[first], rest)
            if (projected !== undefined) output[first] = projected
        }
        if ((projection._id !== 0 && projection._id !== false) && record._id !== undefined)
            output._id = record._id
        return output
    }

    const paths = excludes.map(([key]) => key.replace(/\[(\d+)\]/g, '.$1').split('.'))
    if (projection._id === 0 || projection._id === false) paths.push(['_id'])
    return excludeView(record, paths)
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
        ? sortData(matches, normalizeSort(filter.sort))
        : matches
    const searched = filter?.search ? sorted.filter(record => searchData(record, filter.search)) : sorted
    const startingIndex = storagePosition?.startingIndex ?? filter?.startingIndex ?? filter?.index ?? 0
    const limit = filter?.limit
    const page = searched.slice(startingIndex, limit ? startingIndex + limit : undefined)

    if (storagePosition) {
        storagePosition.count = count
        storagePosition.index = startingIndex + page.length
    }

    return page.map(record => {
        const result = live(project(record, filter?.key))
        result.$storage ??= record.$storage ?? ['db']
        if (record.$database) result.$database = record.$database
        if (record.$array) result.$array = record.$array
        return result
    })
}
