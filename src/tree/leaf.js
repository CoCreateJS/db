import {objectToDotNotation, getValueFromObject, uuid, createUpdate} from '@cocreate/utils'
const TIER=Symbol('leafTier')
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
export class DiskBranch {
    constructor(local, index) {
        this.local = local
        this.uuid = index.uuid
        this.tree = index.tree
    }
    async load() {
        const index = await this.tree?.loadUuid?.(this.uuid)
        if (!index) throw Error('Missing index ' + this.uuid)
        return await index.toMemory()
    }
}

export function* residentIndexEntries(object) {
    for (const entry of Object.values(object[INDEX])) {
        if (entry instanceof Entry) yield entry
    }
}

export function hasIndexEntry(object, key, tree) {
    const entry = object[INDEX]?.[key]
    return entry?.tree === tree && (entry instanceof DiskBranch || entry instanceof Entry)
}

export function restoreIndexEntry(object, index, value, id) {
    const key = index.tree.key
    const slot = object?.[INDEX]?.[key]
    if (slot instanceof Entry && slot.uuid === object.uuid) {
        slot.value = value
        slot.index = index
        slot.tree = index.tree
        slot.releaseObject()
        return slot
    }
    if (slot instanceof DiskBranch && slot.uuid !== index.uuid) return
    if (slot && !(slot instanceof DiskBranch)) return
    const entry = new Entry(object, key, object?.uuid ?? id, value)
    entry.index = index
    entry.tree = index.tree
    entry.releaseObject()
    return entry
}

class Entry {
    constructor(object,key,id=object?.uuid,value=object?get(object,key):undefined){this.uuid=id;this.leaf=object;this.key=key;this._value=value;this.index=null;this.tree=null}
    get object(){
        const object=this.leaf??this.tree?.resolveLeaf?.(this.uuid)??this.tree?.local?.resolveLeaf?.(this.uuid)
        if(object&&object[INDEX])object[INDEX][this.key]=this
        return object
    }
    get value(){return Object.hasOwn(this,SNAPSHOT)?this[SNAPSHOT]:this._value}
    set value(value){this._value=value;delete this.coldValue}
    releaseObject(){this.leaf=null}
    canDetach() { return !Object.hasOwn(this, SNAPSHOT) }
    detach(disk) {
        if(this.leaf)this.leaf[INDEX][this.key] = disk
        this.index = null
        this.tree = disk.tree
        this.releaseObject()
    }
    getValue(){return this.value}
    async insert(tree){await tree.insert(this);return this}
    async setValue(value){return await this.object.setValue(this.key,value)}
    async delete(){return await this.object.delete(this.key)}
}
const prototype=Object.create(Object.prototype)
Object.defineProperties(prototype,{
    getUuid:{value(){return this.uuid}},
    getData:{value:async function(){const object=await this.toMemory();if(object!==this)return await object.getData();return {viewed:this.viewed,object:Object.fromEntries(Object.entries(this))}}},
    getFile:{value:async function(){return {uuid:this.getUuid(),content:JSON.stringify(await this.getData())}}},
    viewed:{get(){return this[TIER]?.viewed??0}},
    touch:{value:async function(){const r=this[TIER];if(r?.object===this){const object=await r.tier.hydrate(r);if(object!==this)return await object.touch();r.tier.touch(r)};return this}},
    toDisk:{value(){const r=this[TIER];return r?.object===this?r.tier.evictOne(r):false}},
    toMemory:{value:async function(){const r=this[TIER];return r?.object===this?await r.tier.hydrate(r):this}},
    getIndex:{value:async function(key){
        const current=await this.toMemory();if(current!==this)return await current.getIndex(key)
        const index = this[INDEX]
        if (key !== undefined) {
            const slot = index[key]
            if (slot instanceof DiskBranch) await slot.load()
            else if (slot instanceof Entry && !slot.index) await this[ATTACH]?.(slot)
            return index[key]
        }
        for (const name of Object.keys(index)) {
            const slot = index[name]
            if (slot instanceof DiskBranch) await slot.load()
            else if (slot instanceof Entry && !slot.index) await this[ATTACH]?.(slot)
        }
        return index
    }},
    getValue:{value:async function(key){const current=await this.toMemory();if(current!==this)return await current.getValue(key);await this.touch?.();return get(this,key)}},
    setValue:{value:async function(key,value){
        const current=await this.toMemory();if(current!==this)return await current.setValue(key,value)
        if(await this[Symbol.for("cocreate.isLiveLeaf")]?.()===false)throw Error("Leaf not found")
        await this.touch?.();await this[DEFER]?.flush(this)
        if(['uuid','parent','root','_id'].includes(key)||this[STRUCTURAL]&&key==='name')throw Error(`immutable ${key}`);if(!scalar(value)||typeof value==='number'&&!Number.isFinite(value))throw Error('scalar update required')
        const parts=key.replace(/\[(\d+)\]/g,'.$1').split('.');if(parts.some(k=>!k||['__proto__','constructor','prototype'].includes(k)))throw Error('invalid path')
        const parent=parts.length===1?this:get(this,parts.slice(0,-1).join('.')), property=parts.at(-1)
        if(!parent||typeof parent!=='object'||(parent===this&&property in prototype)||Object.hasOwn(parent,property)&&!scalar(parent[property]))throw Error('unsupported path')
        const slot = this[INDEX][key]
        const previous = slot instanceof DiskBranch ? get(this, key) : slot?.value
        if (slot && Object.is(previous, value)) return this
        const entry = await this.getIndex(key)
        const write=()=>{parent[property]=value}
        if(entry?.index&&type(entry.value)===type(value)){
            write();await this[Symbol.for("cocreate.markDirty")]?.()
            await entry.tree.move(entry,value,()=>{entry.value=value})
        } else {
            write();await this[Symbol.for("cocreate.markDirty")]?.()
            if(entry?.index)await entry.tree.remove(entry)
            const e=entry??(this[INDEX][key]=new Entry(this,key));e.value=value;await this[ATTACH]?.(e)
        }
        return this
    }},
    delete:{value:async function(key){const current=await this.toMemory();if(current!==this)return await current.delete(key);if(key===undefined)return await this[Symbol.for("cocreate.deleteLeaf")]();if(await this[Symbol.for("cocreate.isLiveLeaf")]?.()===false)throw Error("Leaf not found");await this.touch?.();await this[DEFER]?.flush(this);if(['uuid','parent','root','_id'].includes(key)||this[STRUCTURAL]&&key==='name')throw Error(`immutable ${key}`);const entry=await this.getIndex(key);if(!entry)return false;const parts=key.replace(/\[(\d+)\]/g,'.$1').split('.'),parent=parts.length===1?this:get(this,parts.slice(0,-1).join('.'));delete parent[parts.at(-1)];await this[Symbol.for("cocreate.markDirty")]?.();if(entry.index)await entry.tree.remove(entry);delete this[INDEX][key];return true}}
})
export function createLeaf(object, structural = false, { deferIndex = false } = {}){
    if(Object.getPrototypeOf(object)!==Object.prototype)throw Error('plain object required')
    for(const key of ['getValue','setValue','getIndex','delete','viewed','touch','toDisk','toMemory','getUuid','getData','getFile'])if(Object.hasOwn(object,key))throw Error('reserved key')
    if(!deferIndex)pruneUndefined(object);const keys=deferIndex?undefined:paths(object);object.uuid??=uuid();if(typeof object.uuid!=='string'||!object.uuid)throw Error('invalid uuid')
    Object.defineProperty(object,'uuid',{writable:false,configurable:false,enumerable:true,value:object.uuid})
    for(const key of structural?['parent','root','name']:['parent','root'])if(Object.hasOwn(object,key))Object.defineProperty(object,key,{writable:false,configurable:false,enumerable:true,value:object[key]})
    const index=Object.create(null);if(keys)for(const key of keys.keys())if(key!=='uuid')index[key]=new Entry(object,key)
    Object.defineProperties(object,{[STRUCTURAL]:{value:structural},[INDEX]:{value:index},[ATTACH]:{value:null,writable:true}});Object.setPrototypeOf(object,prototype);return object
}
export async function attach(object,insert){object[ATTACH]=insert;for(const entry of residentIndexEntries(object))await insert(entry)}
export function initializeLeaf(object,insert){object[ATTACH]=insert;return object}

export function deferLeaf(object,handler){
    if(object[DEFER])return undefined
    Object.defineProperty(object,DEFER,{value:handler,configurable:true})
    return()=>delete object[DEFER]
}
export async function reconcileLeaf(object,insert){
    pruneUndefined(object)
    const after=paths(object),index=object[INDEX]
    for(const key of Object.keys(index)){
        const entry=index[key]
        if (entry instanceof DiskBranch) continue
        if(entry.index&&(!after.has(key)||!Object.is(entry.value,after.get(key))))await entry.tree.remove(entry)
        delete entry[SNAPSHOT]
        if(after.has(key))entry.value=after.get(key)
        if(!after.has(key))delete index[key]
    }
    for(const key of after.keys())if(key!=='uuid'&&!index[key])index[key]=new Entry(object,key)
    object[ATTACH]=insert
    for(const entry of residentIndexEntries(object))if(!entry.index)await insert(entry)
}
export async function updateLeaf(object,patch){
    if(await object[Symbol.for("cocreate.isLiveLeaf")]?.()===false)throw Error("Leaf not found")
    await object.touch?.();await object.getIndex();const next=structuredClone(object)
    if(createUpdate(next,patch)===false)throw Error('Invalid update')
    if(object[STRUCTURAL]&&next.name!==object.name)throw Error("Root rename not supported yet")
    if(next.uuid!==object.uuid||next._id!==object._id||next.parent!==object.parent||next.root!==object.root)throw Error('immutable identity')
    pruneUndefined(next);const after=paths(next),index=object[INDEX],changed=[]
    if(object[DEFER]){
        let changed=false
        for(const key of Object.keys(index)){
            const slot = index[key]
            const before = slot instanceof DiskBranch ? get(object, key) : slot.value
            if(!after.has(key)||!Object.is(before,after.get(key))){
                const entry = await object.getIndex(key)
                if(entry.index&&!Object.hasOwn(entry,SNAPSHOT))entry[SNAPSHOT]=before
                changed=true
            }
        }
        for(const key of after.keys())if(key!=='uuid'&&!index[key])changed=true
        for(const key of Object.keys(object))if(!['uuid','parent','root'].includes(key)&&!Object.hasOwn(next,key))delete object[key]
        for(const key of Object.keys(next))if(!['uuid','parent','root'].includes(key)&&!(object[STRUCTURAL]&&key==='name'))object[key]=next[key]
        if(changed)await object[Symbol.for("cocreate.markDirty")]?.()
        if(changed)object[DEFER].queue(object)
        return object
    }
    for(const key of Object.keys(index)){
        const slot = index[key]
        const before = slot instanceof DiskBranch ? get(object, key) : slot.value
        if(!after.has(key)||!Object.is(before,after.get(key)))changed.push(key)
    }
    for(const key of after.keys())if(key!=='uuid'&&!index[key])changed.push(key)
    if(!changed.length)return object
    for(const key of Object.keys(object))if(!['uuid','parent','root'].includes(key)&&!Object.hasOwn(next,key))delete object[key]
    for(const key of Object.keys(next))if(!['uuid','parent','root'].includes(key)&&!(object[STRUCTURAL]&&key==='name'))object[key]=next[key]
    await object[Symbol.for("cocreate.markDirty")]?.()
    const reinsert=[]
    for(const key of changed){
        let entry=index[key]
        if(entry){entry=await object.getIndex(key);if(entry.index)await entry.tree.remove(entry)}
        if(!after.has(key))delete index[key]
        else {entry??=(index[key]=new Entry(object,key));entry.value=after.get(key);reinsert.push(entry)}
    }
    for(const entry of reinsert)await object[ATTACH]?.(entry)
    return object
}

export function restoreLeafIndex(object,index){const target=object[INDEX];for(const key of Object.keys(target))delete target[key];Object.assign(target,index)}

export function bindLeafTier(object,ref){Object.defineProperty(object,TIER,{value:ref})}
