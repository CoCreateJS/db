import {queryData} from '@cocreate/utils'
import {type} from '../artifact.js'
export function queryTree(scope,query={},limit=Infinity){
    if(scope.indexError)throw scope.indexError
    if(limit<=0)return []
    if(typeof query.uuid==='string'){const object=scope.artifacts.get(query.uuid);return object&&queryData(object,query)?[object]:[]}
    let candidate
    for(const [key,condition] of Object.entries(query)){
        if(key.startsWith('$') || key.includes('[') || /(^|\.)\d+(\.|$)|^\.|\.$|\.\./.test(key))continue
        const bounds=condition!==null&&typeof condition==='object'?condition:{$eq:condition}
        const equality=Object.hasOwn(bounds,'$eq')
        const min=equality?bounds.$eq:(bounds.$gte??bounds.$gt)
        const max=equality?bounds.$eq:(bounds.$lte??bounds.$lt)
        const value=min===undefined?max:min
        if(value!==null&&!['number','string','boolean'].includes(typeof value))continue
        const tree=scope.tree.get(key)?.get(type(value));if(!tree)continue
        if(!equality&&(value===null||
            Object.keys(bounds).some(op=>!['$gt','$gte','$lt','$lte'].includes(op)||type(bounds[op])!==type(value)||
                typeof bounds[op]==='number'&&!Number.isFinite(bounds[op]))))continue
        if(!candidate||tree.root.length<candidate.tree.root.length)candidate={tree,min,max,key,range:!equality}
    }
    function* indexedCandidates({tree,min,max,key,range}){
        for(const entry of tree.scan(min,max)){
            const object=entry.object
            if(!scope.pendingIndex?.has(object))yield object
        }
        yield* (scope.pendingIndex ?? [])
        // Other types and unindexed containers can also satisfy a native range.
        if(range&&tree.root.length!==scope.artifacts.size){
            for(const object of scope.artifacts.values()){
                if(scope.pendingIndex?.has(object))continue
                const entry=object.getIndex(key)
                if(entry?.tree!==tree||!entry.partition)yield object
            }
        }
    }
    const source=candidate?indexedCandidates(candidate):scope.artifacts.values()
    const result=[];for(const object of source){if(scope.artifacts.get(object.uuid)===object && queryData(object,query)){result.push(object);if(result.length>=limit)break}}return result
}
