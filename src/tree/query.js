import {queryData} from '@cocreate/utils'
import {type,get} from '../artifact.js'
const operators={$eq:(a,b)=>a===b,$gt:(a,b)=>a>b,$gte:(a,b)=>a>=b,$lt:(a,b)=>a<b,$lte:(a,b)=>a<=b}
function matches(value,condition){if(condition===null||typeof condition!=='object')return value===condition;return Object.entries(condition).every(([op,v])=>{if(!operators[op])throw Error('unsupported operator '+op);return type(value)===type(v)&&operators[op](value,v)})}
export function queryTree(scope,query={},limit=Infinity){
    if(limit<=0)return []
    if(typeof query.uuid==='string'){const object=scope.artifacts.get(query.uuid);return object&&queryData(object,query)?[object]:[]}
    let candidate
    for(const [key,condition] of Object.entries(query)){
        if(key.startsWith('$'))continue
        const bounds=condition!==null&&typeof condition==='object'?condition:{$eq:condition};if(Object.keys(bounds).some(op=>!operators[op]))continue;const values=Object.values(bounds);if(!values.length||values.some(v=>type(v)!==type(values[0])))continue
        const tree=scope.tree.get(key)?.get(type(values[0]));if(!tree)continue
        const min=bounds.$eq??bounds.$gte??bounds.$gt,max=bounds.$eq??bounds.$lte??bounds.$lt
        if(!candidate||tree.root.length<candidate.tree.root.length)candidate={tree,min,max,key,bounds}
    }
    const source=candidate?(function*(){for(const entry of candidate.tree.scan(candidate.min,candidate.max))yield entry.object})():scope.artifacts.values()
    const result=[];for(const object of source){if(queryData(object,query)){result.push(object);if(result.length>=limit)break}}return result
}
