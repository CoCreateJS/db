import {objectToDotNotation, getValueFromObject, uuid, createUpdate} from '@cocreate/utils'
const INDEX=Symbol('index'), ATTACH=Symbol('attach'), STRUCTURAL=Symbol('structural')
const scalar=v=>v===null||['string','number','boolean'].includes(typeof v)
export const type=v=>v===null?'null':typeof v
export const get=getValueFromObject
function pruneUndefined(object){
    for(const key of Object.keys(object)){
        const value=object[key]
        if(value===undefined){delete object[key];continue}
        if(value!==null&&typeof value==='object')pruneUndefined(value)
    }
}
function paths(object){
    const flattened=objectToDotNotation(object)
    for(const [key,value] of Object.entries(flattened)){
        if(key.replace(/\[\d+\]/g,'.0').split('.').some(k=>['__proto__','constructor','prototype'].includes(k)))throw Error('unsupported key')
        if(!scalar(value)||typeof value==='number'&&!Number.isFinite(value))throw Error('unsupported value')
    }
    return new Map(Object.entries(flattened))
}
class Entry {
    constructor(object,key){this.object=object;this.key=key;this.partition=null;this.tree=null}
    get uuid(){return this.object.uuid}
    get value(){return get(this.object,this.key)}
    getValue(){return this.value}
    insert(tree){tree.insert(this);return this}
    setValue(value){return this.object.setValue(this.key,value)}
    delete(){return this.object.delete(this.key)}
}
const prototype=Object.create(Object.prototype)
Object.defineProperties(prototype,{
    getIndex:{value(key){return key===undefined?this[INDEX]:this[INDEX][key]}},
    getValue:{value(key){return get(this,key)}},
    setValue:{value(key,value){
        if(['uuid','parent','scope'].includes(key)||this[STRUCTURAL]&&key==='name')throw Error(`immutable ${key}`);if(!scalar(value)||typeof value==='number'&&!Number.isFinite(value))throw Error('scalar update required')
        const parts=key.replace(/\[(\d+)\]/g,'.$1').split('.');if(parts.some(k=>!k||['__proto__','constructor','prototype'].includes(k)))throw Error('invalid path')
        const parent=parts.length===1?this:get(this,parts.slice(0,-1).join('.')), property=parts.at(-1)
        if(!parent||typeof parent!=='object'||(parent===this&&property in prototype)||Object.hasOwn(parent,property)&&!scalar(parent[property]))throw Error('unsupported path')
        const entry=this[INDEX][key];if(entry&&Object.is(entry.value,value))return this
        const write=()=>{parent[property]=value}
        if(entry?.partition&&type(entry.value)===type(value))entry.tree.move(entry,value,write)
        else {if(entry?.partition)entry.tree.remove(entry);write();const e=entry??(this[INDEX][key]=new Entry(this,key));this[ATTACH]?.(e)}
        return this
    }},
    delete:{value(key){if(['uuid','parent','scope'].includes(key)||this[STRUCTURAL]&&key==='name')throw Error(`immutable ${key}`);const entry=this[INDEX][key];if(!entry)return false;if(entry.partition)entry.tree.remove(entry);const parts=key.replace(/\[(\d+)\]/g,'.$1').split('.'),parent=parts.length===1?this:get(this,parts.slice(0,-1).join('.'));delete parent[parts.at(-1)];delete this[INDEX][key];return true}}
})
export function createArtifact(object, structural = false){
    if(Object.getPrototypeOf(object)!==Object.prototype)throw Error('plain object required')
    for(const key of ['getValue','setValue','getIndex','delete'])if(Object.hasOwn(object,key))throw Error('reserved key')
    pruneUndefined(object);const keys=paths(object);object.uuid??=uuid();if(typeof object.uuid!=='string'||!object.uuid)throw Error('invalid uuid')
    Object.defineProperty(object,'uuid',{writable:false,configurable:false,enumerable:true,value:object.uuid})
    for(const key of structural?['parent','scope','name']:['parent','scope'])if(Object.hasOwn(object,key))Object.defineProperty(object,key,{writable:false,configurable:false,enumerable:true,value:object[key]})
    const index=Object.create(null);for(const key of keys.keys())if(key!=='uuid')index[key]=new Entry(object,key)
    Object.defineProperties(object,{[STRUCTURAL]:{value:structural},[INDEX]:{value:index},[ATTACH]:{value:null,writable:true}});Object.setPrototypeOf(object,prototype);return object
}
export function attach(object,insert){object[ATTACH]=insert;for(const entry of Object.values(object.getIndex()))insert(entry)}

export function updateArtifact(object,patch){
    const next=structuredClone(object)
    if(createUpdate(next,patch)===false)throw Error('Invalid update')
    if(object[STRUCTURAL]&&next.name!==object.name)throw Error("Scope rename not supported yet")
    if(next.uuid!==object.uuid||next._id!==object._id||next.parent!==object.parent||next.scope!==object.scope)throw Error('immutable identity')
    pruneUndefined(next);const after=paths(next),index=object.getIndex(),changed=[]
    for(const key of Object.keys(index)){
        const entry=index[key]
        if(!after.has(key)||!Object.is(entry.value,after.get(key))){
            if(entry.partition)entry.tree.remove(entry)
            if(!after.has(key))delete index[key];else changed.push(entry)
        }
    }
    for(const key of Object.keys(object))if(!['uuid','parent','scope'].includes(key)&&!Object.hasOwn(next,key))delete object[key]
    for(const key of Object.keys(next))if(!['uuid','parent','scope'].includes(key)&&!(object[STRUCTURAL]&&key==='name'))object[key]=next[key]
    for(const key of after.keys())if(key!=='uuid'&&!index[key])changed.push(index[key]=new Entry(object,key))
    for(const entry of changed)object[ATTACH]?.(entry)
    return object
}
