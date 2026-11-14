const entityKey = value => JSON.stringify([
    value.organization_id, value.storageId, value.databaseId, value.arrayId, value.objectId
])

export function mergeDistributionLists(local, peers, key = 'id') {
    const values = new Map()
    for (const item of [...local, ...peers]) {
        const previous = values.get(item[key])
        values.set(item[key], { ...item, nodeIds: [...new Set([...(previous?.nodeIds ?? []), ...item.nodeIds])].sort() })
    }
    return [...values.values()]
}

/** Local updates use the file-backed index; peer updates stay in memory. */
export function createDistributionAdapters(nodeId, peers) {
    const update = (payload, apply) => !nodeId || payload.nodeId === nodeId ? apply(payload) : peers.update(payload)
    return {
        distributionAdapter: {
            update,
            get: async (payload, read) => [...new Set([...await read(payload), ...peers.get(payload)])].sort(),
            list: async (payload, read) => mergeDistributionLists(await read(payload), peers.list(payload))
        },
        partitionAdapter: {
            update,
            get: async (path, read) => [...new Set([...await read(path), ...peers.getPartition(path)])].sort(),
            list: async read => mergeDistributionLists(await read(), peers.listPartitions(), 'partitionId')
        }
    }
}

/** Peer inventories belong only to this process, never to the file/index store. */
export function createPeerDistribution(localId) {
    const inventories = new Map()
    const retiredSessions = new Map()
    const disconnected = new Set()
    const inventory = nodeId => {
        if (!inventories.has(nodeId)) inventories.set(nodeId, { entities: new Map(), partitions: new Set() })
        return inventories.get(nodeId)
    }
    const update = value => {
        if (value.nodeId === localId) return { changed: false, nodeIds: [] }
        const peer = inventory(value.nodeId)
        const key = value.partitionId ?? entityKey(value)
        const entries = value.partitionId ? peer.partitions : peer.entities
        const had = entries.has(key)
        if (value.operation === 'remove') entries.delete(key)
        else if (value.partitionId) entries.add(key)
        else entries.set(key, value)
        return { changed: had !== entries.has(key), nodeIds: value.partitionId ? getPartition(key) : get(value) }
    }
    const get = value => {
        const key = entityKey(value)
        return [...inventories].filter(([, peer]) => peer.entities.has(key)).map(([id]) => id)
    }
    const getPartition = path => [...inventories].filter(([, peer]) => peer.partitions.has(path)).map(([id]) => id)
    const list = (scope = {}) => {
        const result = new Map()
        for (const [nodeId, peer] of inventories) for (const value of peer.entities.values()) {
            if (!value.databaseId) continue
            if (value.organization_id !== scope.organization_id || value.storageId !== scope.storageId) continue
            if (scope.databaseId !== undefined && value.databaseId !== scope.databaseId) continue
            if (scope.arrayId !== undefined && value.arrayId !== scope.arrayId) continue
            if (scope.databaseId === undefined && value.arrayId !== undefined) continue
            if (scope.databaseId !== undefined && scope.arrayId === undefined && (value.arrayId === undefined || value.objectId !== undefined)) continue
            if (scope.arrayId !== undefined && value.objectId === undefined) continue
            const id = scope.arrayId !== undefined ? value.objectId : scope.databaseId !== undefined ? value.arrayId : value.databaseId
            if (!result.has(id)) result.set(id, new Set())
            result.get(id).add(nodeId)
        }
        return [...result].map(([id, nodes]) => ({ id, nodeIds: [...nodes] }))
    }
    return {
        get, list, getPartition, update, updatePartition: update,
        listPartitions: () => {
            const result = new Map()
            for (const [nodeId, peer] of inventories) for (const partitionId of peer.partitions) {
                if (!result.has(partitionId)) result.set(partitionId, [])
                result.get(partitionId).push(nodeId)
            }
            return [...result].map(([partitionId, nodeIds]) => ({ partitionId, nodeIds }))
        },
        replace(nodeId, snapshot, session, revision = 0) {
            if (nodeId === localId) return false
            if (disconnected.has(nodeId)) return false
            if (retiredSessions.get(nodeId)?.has(session)) return false
            const previous = inventories.get(nodeId)
            if (previous && previous.session === session && previous.revision > revision) return false
            if (previous?.session && previous.session !== session) {
                if (!retiredSessions.has(nodeId)) retiredSessions.set(nodeId, new Set())
                retiredSessions.get(nodeId).add(previous.session)
            }
            inventories.set(nodeId, {
                entities: new Map(snapshot.entities.map(value => [entityKey(value), { ...value, nodeId }])),
                partitions: new Set(snapshot.partitions.map(value => value.partitionId)), session, revision
            })
            return true
        },
        change(value, session, revision) {
            if (disconnected.has(value.nodeId)) return false
            if (value.nodeId === localId || retiredSessions.get(value.nodeId)?.has(session)) return false
            const peer = inventories.get(value.nodeId)
            if (peer && peer.session === session && peer.revision >= revision) return false
            if (peer?.session && session && peer.session !== session) return false
            update(value)
            Object.assign(inventory(value.nodeId), { session, revision })
            return true
        },
        remove: nodeId => {
            disconnected.add(nodeId)
            return inventories.delete(nodeId)
        },
        connect: nodeId => disconnected.delete(nodeId),
        findScope(organization, storage) {
            for (const peer of inventories.values()) for (const value of peer.entities.values())
                if (value.organization_id === organization && value.storage === storage) return value
        },
        findFile(uuid) {
            const nodes = []
            for (const [nodeId, peer] of inventories) {
                for (const value of peer.entities.values()) {
                    if ([value.objectId, value.databaseFileId, value.arrayFileId, value.storageFileId].includes(uuid)) {
                        nodes.push(nodeId)
                        break
                    }
                }
            }
            return nodes
        }
    }
}
