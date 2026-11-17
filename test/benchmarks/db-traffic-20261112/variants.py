from pathlib import Path
import shutil,tempfile
out=Path(__file__).parent; baseline=Path((out/'snapshot.txt').read_text().strip())
for variant in ['holders','coalesced','both']:
 root=Path(tempfile.mkdtemp(prefix='coc-db-traffic-'+variant+'-'));shutil.copytree(baseline/'src',root/'src');(root/'node_modules').symlink_to('/home/ubuntu/Dev/CoCreateJS/modules/db/node_modules',target_is_directory=True)
 if variant in ['holders','both']:
  p=root/'src/distribution.js';s=p.read_text().replace('    let queue = Promise.resolve()','    const entityCache = new Map(), partitionCache = new Map()\n    let queue = Promise.resolve()')
  s=s.replace('''        const target = address({ databaseId, arrayId, objectId })
        const nodeIds = []''','''        const target = address({ databaseId, arrayId, objectId })
        const cacheKey = JSON.stringify([databaseId, arrayId, objectId]);
        if (entityCache.has(cacheKey)) return entityCache.get(cacheKey);
        const nodeIds = []''',1)
  a=s.index('    const get = async');b=s.index('    const list = async',a);block=s[a:b].replace('        return nodeIds','        entityCache.set(cacheKey, nodeIds);\n        return nodeIds');s=s[:a]+block+s[b:]
  a=s.index('    const getPartition = async');b=s.index('    const listPartitions',a);block=s[a:b].replace('        const nodeIds = []','        if (partitionCache.has(partitionId)) return partitionCache.get(partitionId);\n        const nodeIds = []').replace('        return nodeIds','        partitionCache.set(partitionId, nodeIds);\n        return nodeIds');s=s[:a]+block+s[b:]
  s=s.replace('''        return { changed, nodeIds: await getPartition(partitionId) }''','''        if (changed) { if (operation === 'add') existing.push(nodeId); else existing.splice(existing.indexOf(nodeId), 1); }
        return { changed, nodeIds: existing }''')
  s=s.replace('''        return { changed, nodeIds: await get({ databaseId, arrayId, objectId }) }''','''        if (changed) { if (operation === 'add') existing.push(nodeId); else existing.splice(existing.indexOf(nodeId), 1); }
        return { changed, nodeIds: existing }''')
  s=s.replace('''        clearCache: () => {
            index.clearCache()''','''        clearCache: () => {
            entityCache.clear(); partitionCache.clear();
            index.clearCache()''');p.write_text(s)
 if variant in ['coalesced','both']:
  p=root/'src/server.js';s=p.read_text();a=s.index('    const publish = payload =>');b=s.index('    const withPropagation',a)
  s=s[:a]+'''    const pendingFrames = new Map();
    const publish = payload => {
        if (!outgoing) return meshSend(payload);
        if (payload.method === 'db.partition.update') {
            const key = JSON.stringify([payload.server,payload.path ?? payload.partitionId,payload.organization_id,payload.storageId]);
            if (pendingFrames.has(key)) { outgoing[pendingFrames.get(key)] = payload; return; }
            pendingFrames.set(key,outgoing.length);
        }
        outgoing.push(payload);
    };
    const dispatchChanges = () => {
        for (let i=0;i<(outgoing?.length ?? 0);i++) meshSend(outgoing[i]);
        if (outgoing) outgoing.length=0;
        pendingFrames.clear();
    };
'''+s[b:];s=s.replace('''        outgoing = messages
        try {''','''        outgoing = messages
        pendingFrames.clear();
        try {''');p.write_text(s)
 (out/f'snapshot-{variant}.txt').write_text(str(root)+'\n');print(variant,root)
