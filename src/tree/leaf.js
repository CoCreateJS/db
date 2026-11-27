import {getValueFromObject, uuid, createUpdate} from '@cocreate/utils'
const TIER=Symbol('leafTier')
const RESTORE=Symbol('restoreIndexes')
const INDEX=Symbol('index'), ATTACH=Symbol('attach'), STRUCTURAL=Symbol('structural'), DEFER=Symbol('defer'), SNAPSHOT=Symbol('snapshot')
const scalar=v=>v===null||['string','number','boolean'].includes(typeof v)
const updateMarkers=new Set(['$set','$inc','$unset','$delete','$rename','$push','$each','$splice','$slice','$pop','$shift','$addToSet','$pull'])
export const type=v=>v===null?'null':Array.isArray(v)?'array':typeof v
export const get=getValueFromObject
function pruneUndefined(object){
    for(const key of Object.keys(object)){
        const value=object[key]
        if(value===undefined){delete object[key];continue}
        if(value!==null&&typeof value==='object')pruneUndefined(value)
    }
}
const emptyArray = Object.freeze([]), emptyObject = Object.freeze({})
const indexValue = value => value && typeof value === 'object' && !Object.keys(value).length
    ? Array.isArray(value) ? emptyArray : emptyObject : value

// Index scalar paths and empty containers in one traversal. Empty containers
// need their own type buckets so presence, coercion and sorting stay exact.
export function indexValues(object, prefix = '') {
    const values = new Map()
    const visit = (value, path) => {
        if (value !== null && typeof value === 'object') {
            const keys = Object.keys(value)
            if (keys.length) {
                for (const key of keys) visit(value[key], Array.isArray(value) ? `${path}[${key}]` : path ? `${path}.${key}` : key)
                return
            }
            if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) throw Error('unsupported value')
        } else if (!scalar(value) || typeof value === 'number' && !Number.isFinite(value)) throw Error('unsupported value')
        if (!path) return
        if (path.replace(/\[\d+\]/g, '.0').split('.').some(key => ['__proto__', 'constructor', 'prototype'].includes(key))) throw Error('unsupported key')
        values.set(path, indexValue(value))
    }
    visit(object, prefix)
    return values
}
const paths = indexValues
function scalarUpdateTargets(patch){
    const targets=[]
    for(const [key,value] of Object.entries(patch)){
        let path=key
        if(key.startsWith('$')){
            const dot=key.indexOf('.')
            const operator=key.slice(0,dot)
            if(dot<0||!['$set','$inc','$unset','$delete'].includes(operator))return
            path=key.slice(dot+1)
            if(operator==='$inc'&&(typeof value!=='number'||!Number.isFinite(value)))return
            if(operator==='$set'&&value!==null&&typeof value==='object')return
        } else if((value!==null&&typeof value==='object')||(typeof value==='string'&&updateMarkers.has(value)))return
        if(value!==undefined&&value!==null&&!['string','number','boolean'].includes(typeof value))return
        if(typeof value==='number'&&!Number.isFinite(value))return
        const parts=path.replace(/\[(\d+)\]/g,'.$1').split('.')
        if(parts.some(part=>!part||['__proto__','constructor','prototype'].includes(part)))return
        targets.push(parts.map(part=>/^\d+$/.test(part)?`[${part}]`:part).reduce((out,part)=>part[0]==='['?out+part:out?`${out}.${part}`:part,''))
    }
    targets.sort((a,b)=>a.length-b.length)
    return [...new Set(targets.filter((path,index)=>!targets.slice(0,index).some(parent=>path.startsWith(parent+'.')||path.startsWith(parent+'['))))]
}
function overlapsPath(key,target){
    const normalized=key.replace(/\[(\d+)\]/g,'.$1')
    const prefix=target.replace(/\[(\d+)\]/g,'.$1')
    return normalized===prefix||normalized.startsWith(prefix+'.')
}
function valuesAtTargets(object, targets) {
    const result = new Map()
    for (const target of targets) {
        const value = get(object, target)
        if (value === undefined) continue
        for (const [key, child] of indexValues(value, target)) result.set(key, child)
    }
    return result
}
export function* residentIndexEntries(object) {
    for (const entry of Object.values(object[INDEX])) {
        if (entry instanceof Entry) yield entry
    }
}

export function hasIndexEntry(object, key) { return object[INDEX]?.[key] instanceof Entry }

export function restoreIndexEntry(object, index, value, id) {
    const key = index.tree.key
    const slot = object?.[INDEX]?.[key]
    if (slot instanceof Entry && slot.uuid === object?.uuid) {
        slot.value = value
        slot.index = index
        slot.tree = index.tree
        slot.releaseObject()
        return slot
    }
    if (slot) return
    const entry = new Entry(object, key, object?.uuid ?? id, value)
    entry.index = index
    entry.tree = index.tree
    if (object) object[INDEX][key] = entry
    entry.releaseObject()
    return entry
}

class Entry {
    constructor(object,key,id=object?.uuid,value=object?get(object,key):undefined){this.uuid=id;this.leaf=object;this.key=key;this._value=indexValue(value);this.index=null;this.tree=null}
    get object(){
        const object=this.leaf??this.tree?.resolveLeaf?.(this.uuid)??this.tree?.local?.resolveLeaf?.(this.uuid)
        if(object&&object[INDEX])object[INDEX][this.key]=this
        return object
    }
    get value(){return Object.hasOwn(this,SNAPSHOT)?this[SNAPSHOT]:this._value}
    set value(value){this._value=indexValue(value)}
    releaseObject(){this.leaf=null}
    getValue(){return this.value}
    async insert(tree){await tree.insert(this);return this}
    async setValue(value){return await (await this.object).setValue(this.key,value)}
    async delete(){return await (await this.object).delete(this.key)}
}
const prototype=Object.create(Object.prototype)
Object.defineProperties(prototype,{
    getUuid:{value(){return this.uuid}},
    getData:{value:async function(){const object=await this.toMemory();if(object!==this)return await object.getData();return {object:Object.fromEntries(Object.entries(this))}}},
    getFile:{value:async function(){return {uuid:this.getUuid(),content:JSON.stringify(await this.getData())}}},
    toMemory:{value:async function(){const r=this[TIER];return r?.object===this?await r.tier.hydrate(r):this}},
    getIndex:{value:async function(key){
        const current=await this.toMemory();if(current!==this)return await current.getIndex(key)
        if (this[RESTORE]) await this[RESTORE](key === undefined ? undefined : [key])
        return key === undefined ? this[INDEX] : this[INDEX][key]
    }},
    getValue:{value:async function(key){const current=await this.toMemory();if(current!==this)return await current.getValue(key);return get(this,key)}},
    setValue:{value:async function(key,value){
        const current=await this.toMemory();if(current!==this)return await current.setValue(key,value)
        if(await this[Symbol.for("cocreate.isLiveLeaf")]?.()===false)throw Error("Leaf not found")
        if(['uuid','parent','root','_id'].includes(key)||this[STRUCTURAL]&&key==='name')throw Error(`immutable ${key}`);if(!scalar(value)||typeof value==='number'&&!Number.isFinite(value))throw Error('scalar update required')
        const parts=key.replace(/\[(\d+)\]/g,'.$1').split('.');if(parts.some(k=>!k||['__proto__','constructor','prototype'].includes(k)))throw Error('invalid path')
        const parent=parts.length===1?this:get(this,parts.slice(0,-1).join('.')), property=parts.at(-1)
        if(!parent||typeof parent!=='object'||(parent===this&&property in prototype)||Object.hasOwn(parent,property)&&!scalar(parent[property]))throw Error('unsupported path')
        const entry = await this.getIndex(key)
        const previous = entry ? entry.value : get(this, key)
        if (Object.is(previous, value)) return this
        const write=()=>{parent[property]=value}
        if(this[DEFER]){
            if(entry?.index&&!Object.hasOwn(entry,SNAPSHOT))entry[SNAPSHOT]=previous
            write();await this[Symbol.for("cocreate.markDirty")]?.();this[DEFER].queue(this,new Set([key]))
            return this
        }
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
    delete:{value:async function(key){const current=await this.toMemory();if(current!==this)return await current.delete(key);if(key===undefined)return await this[Symbol.for("cocreate.deleteLeaf")]();if(await this[Symbol.for("cocreate.isLiveLeaf")]?.()===false)throw Error("Leaf not found");if(['uuid','parent','root','_id'].includes(key)||this[STRUCTURAL]&&key==='name')throw Error(`immutable ${key}`);const entry=await this.getIndex(key);if(!entry&&get(this,key)===undefined)return false;const parts=key.replace(/\[(\d+)\]/g,'.$1').split('.'),parent=parts.length===1?this:get(this,parts.slice(0,-1).join('.'));delete parent[parts.at(-1)];await this[Symbol.for("cocreate.markDirty")]?.();if(this[DEFER]){if(entry?.index&&!Object.hasOwn(entry,SNAPSHOT))entry[SNAPSHOT]=entry.value;this[DEFER].queue(this,new Set([key]));return true}if(entry?.index)await entry.tree.remove(entry);delete this[INDEX][key];return true}}
})
export function createLeaf(object, structural = false){
    if(Object.getPrototypeOf(object)!==Object.prototype)throw Error('plain object required')
    for(const key of ['getValue','setValue','getIndex','delete','toMemory','getUuid','getData','getFile'])if(Object.hasOwn(object,key))throw Error('reserved key')
    object.uuid??=uuid();if(typeof object.uuid!=='string'||!object.uuid)throw Error('invalid uuid')
    Object.defineProperty(object,'uuid',{writable:false,configurable:false,enumerable:true,value:object.uuid})
    for(const key of structural?['parent','root','name']:['parent','root'])if(Object.hasOwn(object,key))Object.defineProperty(object,key,{writable:false,configurable:false,enumerable:true,value:object[key]})
    const index=Object.create(null)
    Object.defineProperties(object,{[STRUCTURAL]:{value:structural},[INDEX]:{value:index},[ATTACH]:{value:null,writable:true}});Object.setPrototypeOf(object,prototype);return object
}
export async function attach(object,insert){object[ATTACH]=insert;for(const entry of residentIndexEntries(object))await insert(entry)}
export function initializeLeaf(object,insert){object[ATTACH]=insert;return object}

export async function removeIndexedEntry(entry){
    const tree=entry.tree
    if(!tree||typeof entry.key!=='string')return false
    const removeFrom=async node=>{
        node=await node.toMemory()
        for(const [value,entries] of node.entries??[]){
            const indexed=entries.find(candidate=>candidate.uuid===entry.uuid)
            if(!indexed)continue
            indexed.value=value
            await tree.remove(indexed)
            entry.index=null
            return true
        }
        return false
    }
    if(entry.index&&await removeFrom(entry.index))return true
    for(const value of new Set([entry.value,entry._value])){
        const node=await tree.locate({value,uuid:entry.uuid})
        if(await removeFrom(node))return true
    }
    return false
}

export function deferLeaf(object,handler){
    if(object[DEFER])return undefined
    Object.defineProperty(object,DEFER,{value:handler,configurable:true})
    return()=>delete object[DEFER]
}
export async function reconcileLeaf(object,insert,changedPaths){
    const selective = changedPaths instanceof Set
    const index=object[INDEX]
    if(!selective&&!Object.keys(index).length){
        pruneUndefined(object)
        for(const [key,value] of paths(object))if(key!=='uuid')index[key]=new Entry(object,key,object.uuid,value)
        object[ATTACH]=insert
        for(const entry of residentIndexEntries(object))await insert(entry)
        return
    }
    if(!selective)pruneUndefined(object)
    const after=selective?undefined:paths(object)
    const keys=selective?changedPaths:new Set(Object.keys(index))
    if(!selective)for(const key of after.keys())keys.add(key)
    for(const key of keys){
        const entry=index[key]
        if(!entry)continue
        const exists=selective?get(object,key)!==undefined:after.has(key)
        const value=selective?get(object,key):after.get(key)
        if(entry?.tree&&(!exists||!Object.is(entry.value,value)))await removeIndexedEntry(entry)
        delete entry[SNAPSHOT]
        if(exists)entry.value=value
        if(!exists)delete index[key]
    }
    for(const key of keys)if(key!=='uuid'&&!index[key]){
        const exists=selective?get(object,key)!==undefined:after.has(key)
        if(exists)index[key]=new Entry(object,key)
    }
    object[ATTACH]=insert
    if(selective){
        for(const key of keys){const entry=index[key];if(entry instanceof Entry&&!entry.index)await insert(entry)}
    } else for(const entry of residentIndexEntries(object))if(!entry.index)await insert(entry)
}
async function updateScalarLeaf(object,patch,targets){
    const identity={uuid:object.uuid,_id:object._id,parent:object.parent,root:object.root,name:object.name}
    for(const path of targets){
        const first=path.split(/[.[]/,1)[0]
        if(['uuid','_id','parent','root'].includes(first))throw Error('immutable identity')
        if(object[STRUCTURAL]&&first==='name')throw Error('Root rename not supported yet')
    }
    if (object[RESTORE]) await object[RESTORE]([...valuesAtTargets(object, targets).keys()])
    const index=object[INDEX],before=new Map()
    for(const key of Object.keys(index))if(targets.some(target=>overlapsPath(key,target))){
        const entry=await object.getIndex(key)
        if(entry)before.set(key,entry.value)
    }
    if(createUpdate(object,patch)===false)throw Error('Invalid update')
    if(object[STRUCTURAL]&&object.name!==identity.name)throw Error('Root rename not supported yet')
    if(object.uuid!==identity.uuid||object._id!==identity._id||object.parent!==identity.parent||object.root!==identity.root)throw Error('immutable identity')
    const after=valuesAtTargets(object,targets),candidates=new Set([...before.keys(),...after.keys()]),changed=[]
    for(const key of candidates)if(!Object.is(before.get(key),after.get(key))||before.has(key)!==after.has(key))changed.push(key)
    if(!changed.length)return object
    await object[Symbol.for('cocreate.markDirty')]?.()
    if(object[DEFER]){
        for(const key of changed){const entry=index[key];if(entry?.index&&!Object.hasOwn(entry,SNAPSHOT))entry[SNAPSHOT]=before.get(key)}
        object[DEFER].queue(object,changed)
        return object
    }
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
export async function updateLeaf(object,patch){
    if(await object[Symbol.for("cocreate.isLiveLeaf")]?.()===false)throw Error("Leaf not found")
    const targets=scalarUpdateTargets(patch)
    if(targets)return await updateScalarLeaf(object,patch,targets)
    await object.getIndex()
    const identity = { uuid: object.uuid, _id: object._id, parent: object.parent, root: object.root, name: object.name }
    for(const [key,value] of Object.entries(patch)){
        const operator=key.startsWith('$')?(key.includes('.')?key.slice(0,key.indexOf('.')):key):undefined
        const paths=operator
            ? key.includes('.')?[key.slice(key.indexOf('.')+1)]:value&&typeof value==='object'?Object.keys(value):[]
            :[key]
        if(operator==='$rename')for(const path of paths){
            const target=key.includes('.')?value:value?.[path]
            if(typeof target==='string')paths.push(target)
        }
        for(const path of paths){
            const first=path.replace(/\[(\d+)\]/g,'.$1').split('.')[0]
            if(['uuid','_id','parent','root'].includes(first))throw Error('immutable identity')
            if(object[STRUCTURAL]&&first==='name')throw Error('Root rename not supported yet')
        }
    }
    if(createUpdate(object,patch)===false)throw Error('Invalid update')
    if(object[STRUCTURAL]&&object.name!==identity.name)throw Error("Root rename not supported yet")
    if(object.uuid!==identity.uuid||object._id!==identity._id||object.parent!==identity.parent||object.root!==identity.root)throw Error('immutable identity')
    pruneUndefined(object);const after=paths(object),index=object[INDEX],changed=[]
    if(object[DEFER]){
        for(const key of Object.keys(index)){
            const slot = index[key]
            const before = slot.value
            if(!after.has(key)||!Object.is(before,after.get(key))){
                const entry = await object.getIndex(key)
                if(entry.index&&!Object.hasOwn(entry,SNAPSHOT))entry[SNAPSHOT]=before
                changed.push(key)
            }
        }
        for(const key of after.keys())if(key!=='uuid'&&!index[key])changed.push(key)
        if(changed.length)await object[Symbol.for("cocreate.markDirty")]?.()
        if(changed.length)object[DEFER].queue(object,changed)
        return object
    }
    for(const key of Object.keys(index)){
        const slot = index[key]
        const before = slot.value
        if(!after.has(key)||!Object.is(before,after.get(key)))changed.push(key)
    }
    for(const key of after.keys())if(key!=='uuid'&&!index[key])changed.push(key)
    if(!changed.length)return object
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

export function bindIndexRestore(object, restore) { Object.defineProperty(object, RESTORE, { value: restore }) }

export function attachIndexEntry(object, entry) { object[INDEX][entry.key] = entry }
