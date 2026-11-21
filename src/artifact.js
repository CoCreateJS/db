import {objectToDotNotation, getValueFromObject, uuid, createUpdate} from '@cocreate/utils'
const TIER=Symbol('artifactTier')
const INDEX=Symbol('index'), ATTACH=Symbol('attach'), STRUCTURAL=Symbol('structural'), DEFER=Symbol('defer'), SNAPSHOT=Symbol('snapshot')
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
export class DiskIndex {
    constructor(local, partition) {
        this.local = local
        this.uuid = partition.uuid
        this.tree = partition.tree
    }
    load() {
        const partition = this.local.coldIndexes.get(this.uuid)
        if (!partition) throw Error('Missing cold index ' + this.uuid)
        partition.toMemory()
    }
}

export function* residentIndexEntries(object) {
    for (const entry of Object.values(object[INDEX])) {
        if (entry instanceof Entry) yield entry
    }
}

export function hasIndexEntry(object, key, tree) {
    const entry = object[INDEX]?.[key]
    return entry?.tree === tree && (entry instanceof DiskIndex || !!entry.partition)
}

export function restoreIndexEntry(object, partition, value) {
    const key = partition.tree.key
    const slot = object?.[INDEX]?.[key]
    if (slot instanceof Entry && slot.partition === partition) return slot
    if (!(slot instanceof DiskIndex) || slot.uuid !== partition.uuid) return
    const entry = new Entry(object, key)
    entry.partition = partition
    entry.tree = partition.tree
    if (object[TIER]?.cold) entry.coldValue = value
    return entry
}

class Entry {
    constructor(object,key){this.artifact=object;this.key=key;this.partition=null;this.tree=null}
    get object(){return this.artifact.toMemory()}
    get uuid(){return this.artifact.uuid}
    get value(){return Object.hasOwn(this,SNAPSHOT)?this[SNAPSHOT]:Object.hasOwn(this,"coldValue")?this.coldValue:get(this.artifact,this.key)}
    releaseObject(){this.coldValue=this.value}
    restoreObject(){delete this.coldValue}
    link() { this.artifact[INDEX][this.key] = this }
    canDetach() { return !Object.hasOwn(this, SNAPSHOT) }
    detach(disk) {
        this.artifact[INDEX][this.key] = disk
        this.partition = null
        this.tree = null
    }
    getValue(){return this.value}
    insert(tree){tree.insert(this);return this}
    setValue(value){return this.object.setValue(this.key,value)}
    delete(){return this.object.delete(this.key)}
}
const prototype=Object.create(Object.prototype)
Object.defineProperties(prototype,{
    getUuid:{value(){return this.uuid}},
    getData:{value(){this.toMemory();return {viewed:this.viewed,object:Object.fromEntries(Object.entries(this))}}},
    getFile:{value(){return {uuid:this.getUuid(),content:JSON.stringify(this.getData())}}},
    viewed:{get(){return this[TIER]?.viewed??0}},
    touch:{value(){const r=this[TIER];if(r?.object===this){r.tier.hydrate(r);r.tier.touch(r)};return this}},
    toDisk:{value(){const r=this[TIER];return r?.object===this?r.tier.evictOne(r):false}},
    toMemory:{value(){const r=this[TIER];return r?.object===this?r.tier.hydrate(r):this}},
    getIndex:{value(key){
        const index = this[INDEX]
        if (key !== undefined) {
            const slot = index[key]
            if (slot instanceof DiskIndex) slot.load()
            return index[key]
        }
        for (const name of Object.keys(index)) {
            const slot = index[name]
            if (slot instanceof DiskIndex) slot.load()
        }
        return index
    }},
    getValue:{value(key){this.touch?.();return get(this,key)}},
    setValue:{value(key,value){
        if(this[Symbol.for("cocreate.isLiveArtifact")]?.()===false)throw Error("Artifact not found")
        this.touch?.();this[DEFER]?.flush(this)
        if(['uuid','parent','scope','_id'].includes(key)||this[STRUCTURAL]&&key==='name')throw Error(`immutable ${key}`);if(!scalar(value)||typeof value==='number'&&!Number.isFinite(value))throw Error('scalar update required')
        const parts=key.replace(/\[(\d+)\]/g,'.$1').split('.');if(parts.some(k=>!k||['__proto__','constructor','prototype'].includes(k)))throw Error('invalid path')
        const parent=parts.length===1?this:get(this,parts.slice(0,-1).join('.')), property=parts.at(-1)
        if(!parent||typeof parent!=='object'||(parent===this&&property in prototype)||Object.hasOwn(parent,property)&&!scalar(parent[property]))throw Error('unsupported path')
        const slot = this[INDEX][key]
        const previous = slot instanceof DiskIndex ? get(this, key) : slot?.value
        if (slot && Object.is(previous, value)) return this
        const entry = this.getIndex(key)
        const write=()=>{parent[property]=value}
        if(entry?.partition&&type(entry.value)===type(value))entry.tree.move(entry,value,write)
        else {if(entry?.partition)entry.tree.remove(entry);write();const e=entry??(this[INDEX][key]=new Entry(this,key));this[ATTACH]?.(e)}
        return this
    }},
    delete:{value(key){if(key===undefined)return this[Symbol.for("cocreate.deleteArtifact")]();if(this[Symbol.for("cocreate.isLiveArtifact")]?.()===false)throw Error("Artifact not found");this.touch?.();this[DEFER]?.flush(this);if(['uuid','parent','scope','_id'].includes(key)||this[STRUCTURAL]&&key==='name')throw Error(`immutable ${key}`);const entry=this.getIndex(key);if(!entry)return false;if(entry.partition)entry.tree.remove(entry);const parts=key.replace(/\[(\d+)\]/g,'.$1').split('.'),parent=parts.length===1?this:get(this,parts.slice(0,-1).join('.'));delete parent[parts.at(-1)];delete this[INDEX][key];return true}}
})
export function createArtifact(object, structural = false){
    if(Object.getPrototypeOf(object)!==Object.prototype)throw Error('plain object required')
    for(const key of ['getValue','setValue','getIndex','delete','viewed','touch','toDisk','toMemory','getUuid','getData','getFile'])if(Object.hasOwn(object,key))throw Error('reserved key')
    pruneUndefined(object);const keys=paths(object);object.uuid??=uuid();if(typeof object.uuid!=='string'||!object.uuid)throw Error('invalid uuid')
    Object.defineProperty(object,'uuid',{writable:false,configurable:false,enumerable:true,value:object.uuid})
    for(const key of structural?['parent','scope','name']:['parent','scope'])if(Object.hasOwn(object,key))Object.defineProperty(object,key,{writable:false,configurable:false,enumerable:true,value:object[key]})
    const index=Object.create(null);for(const key of keys.keys())if(key!=='uuid')index[key]=new Entry(object,key)
    Object.defineProperties(object,{[STRUCTURAL]:{value:structural},[INDEX]:{value:index},[ATTACH]:{value:null,writable:true}});Object.setPrototypeOf(object,prototype);return object
}
export function attach(object,insert){object[ATTACH]=insert;for(const entry of residentIndexEntries(object))insert(entry)}

export function deferArtifact(object,handler){Object.defineProperty(object,DEFER,{value:handler})}
export function reconcileArtifact(object,insert){
    const after=paths(object),index=object[INDEX]
    for(const key of Object.keys(index)){
        const entry=index[key]
        if (entry instanceof DiskIndex) continue
        if(entry.partition&&(!after.has(key)||!Object.is(entry.value,after.get(key))))entry.tree.remove(entry)
        delete entry[SNAPSHOT]
        if(!after.has(key))delete index[key]
    }
    for(const key of after.keys())if(key!=='uuid'&&!index[key])index[key]=new Entry(object,key)
    object[ATTACH]=insert
    for(const entry of residentIndexEntries(object))if(!entry.partition)insert(entry)
}
export function updateArtifact(object,patch){
    if(object[Symbol.for("cocreate.isLiveArtifact")]?.()===false)throw Error("Artifact not found")
    object.touch?.();const next=structuredClone(object)
    if(createUpdate(next,patch)===false)throw Error('Invalid update')
    if(object[STRUCTURAL]&&next.name!==object.name)throw Error("Scope rename not supported yet")
    if(next.uuid!==object.uuid||next._id!==object._id||next.parent!==object.parent||next.scope!==object.scope)throw Error('immutable identity')
    pruneUndefined(next);const after=paths(next),index=object[INDEX],changed=[]
    if(object[DEFER]){
        let changed=false
        for(const key of Object.keys(index)){
            const slot = index[key]
            const before = slot instanceof DiskIndex ? get(object, key) : slot.value
            if(!after.has(key)||!Object.is(before,after.get(key))){
                const entry = object.getIndex(key)
                if(entry.partition&&!Object.hasOwn(entry,SNAPSHOT))entry[SNAPSHOT]=before
                changed=true
            }
        }
        for(const key of after.keys())if(key!=='uuid'&&!index[key])changed=true
        for(const key of Object.keys(object))if(!['uuid','parent','scope'].includes(key)&&!Object.hasOwn(next,key))delete object[key]
        for(const key of Object.keys(next))if(!['uuid','parent','scope'].includes(key)&&!(object[STRUCTURAL]&&key==='name'))object[key]=next[key]
        if(changed)object[DEFER].queue(object)
        return object
    }
    for(const key of Object.keys(index)){
        const slot = index[key]
        const before = slot instanceof DiskIndex ? get(object, key) : slot.value
        if(!after.has(key)||!Object.is(before,after.get(key))){
            const entry = object.getIndex(key)
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

export function restoreArtifactIndex(object,index){const target=object[INDEX];for(const key of Object.keys(target))delete target[key];Object.assign(target,index)}

export function bindArtifactTier(object,ref){Object.defineProperty(object,TIER,{value:ref})}
