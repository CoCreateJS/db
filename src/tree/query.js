import {queryData} from '@cocreate/utils'
import {hasIndexEntry,type} from '../leaf.js'
export async function queryTree(root,query={},limit=Infinity){
    if(root.indexError)throw root.indexError
    if(limit<=0)return []
    if(typeof query.uuid==='string'){const object=await root.leaves.get(query.uuid);return object&&queryData(object,query)?[object]:[]}
    let candidate
    for(const [key,condition] of Object.entries(query)){
        if(key.startsWith('$') || key.includes('[') || /(^|\.)\d+(\.|$)|^\.|\.$|\.\./.test(key))continue
        const bounds=condition!==null&&typeof condition==='object'?condition:{$eq:condition}
        const equality=Object.hasOwn(bounds,'$eq')
        const min=equality?bounds.$eq:(bounds.$gte??bounds.$gt)
        const max=equality?bounds.$eq:(bounds.$lte??bounds.$lt)
        const value=min===undefined?max:min
        if(value!==null&&!['number','string','boolean'].includes(typeof value))continue
        const tree=root.tree.get(key)?.get(type(value));if(!tree)continue
        if(!equality&&(value===null||
            Object.keys(bounds).some(op=>!['$gt','$gte','$lt','$lte'].includes(op)||type(bounds[op])!==type(value)||
                typeof bounds[op]==='number'&&!Number.isFinite(bounds[op]))))continue
        if(!candidate||tree.root.length<candidate.tree.root.length)candidate={tree,min,max,key,range:!equality}
    }
    async function* indexedCandidates({tree,min,max,key,range}){
        for await(const entry of tree.scan(min,max)){
            const object=await root.leaves.get(entry.uuid)
            if(!object)continue
            if(!root.pendingIndex?.has(object))yield object
        }
        yield* (root.pendingIndex ?? [])
        // Pending deletes can still occupy index entries, and Map.size can
        // describe only the resident leaves. Neither proves coverage.
        const leafCount=root.leaves.count?await root.leaves.count():root.leaves.totalSize??root.leaves.size
        if(range&&(root.pendingIndex?.size||tree.root.length!==leafCount)){
            const references=root.leaves.references?.()??root.leaves.values()
            const pending=new Set([...(root.pendingIndex??[])].map(object=>object.uuid))
            for await(const reference of references){
                if(pending.has(reference.uuid))continue
                const resident=await root.leaves.reference?.(reference.uuid)
                const object=resident??reference
                if(!hasIndexEntry(object,key,tree)&&queryData(object,query)){
                    const live=resident??await root.leaves.get(reference.uuid)
                    if(live)yield live
                }
            }
        }
    }
    const source=candidate?indexedCandidates(candidate):root.leaves.values()
    const result=[];for await(const object of source){if(await root.leaves.get(object.uuid)===object && queryData(object,query)){result.push(object);if(result.length>=limit)break}}return result
}
