import {Weights} from '../../tree/weights.js'
import {existsSync,readFileSync,readdirSync} from 'node:fs'
import {rename,writeFile,unlink,readFile,readdir,access} from 'node:fs/promises'
import {bindLeafTier,createLeaf,residentIndexEntries} from '../../leaf.js'

const residentHas = (tier,id) => Map.prototype.has.call(tier,id)
let temporaryFileId = 0
const temporaryPath = path => `${path}.${process.pid}.${temporaryFileId++}.tmp`

// Hot leaves are kept in the Map. Warm files are addressed by UUID;
// there is deliberately no UUID-to-file-object registry.
export class LeafTier extends Map {
    constructor(local){
        super()
        this.local=local
        this.weights=new Weights()
        this.buckets=this.weights
        this.refs=new WeakMap()
        this.dirty=new Map()
        this.writeLocks=new Map()
        this.reads=0
        this.writes=0
    }
    files(){
        return readdirSync(this.local.leafDirectory)
            .filter(name=>name.endsWith('.json'))
            .map(name=>Buffer.from(name.slice(0,-5),'hex').toString())
    }
    // A computed view of warm files; it stores no objects or IDs.
    get warm(){
        const tier=this
        return {
            get size(){return tier.files().length},
            has(id){return existsSync(tier.local.leafPath(id))},
            *keys(){yield* tier.files()}
        }
    }
    add(record){this.weights.add(record)}
    remove(record){this.weights.remove(record)}
    markDirty(object){this.dirty.set(object.uuid,object)}
    withWriteLock(id,operation){
        const previous=this.writeLocks.get(id)??Promise.resolve()
        const task=previous.catch(()=>{}).then(operation)
        this.writeLocks.set(id,task)
        return task.finally(()=>{if(this.writeLocks.get(id)===task)this.writeLocks.delete(id)})
    }
    async deleteFile(id){return await this.withWriteLock(id,()=>this.local.deleteLeaf(id))}
    touch(record){if(record.object&&!record.evicted)this.weights.touch(record)}
    set(id,object){
        super.set(id,object)
        if(object.root==='object'){
            let record=this.refs.get(object)
            if(!record){record={id,object,viewed:0,tier:this};this.refs.set(object,record);bindLeafTier(object,record)}
            record.object=object
            this.add(record)
        }
        return this
    }
    reserve(id,object){
        this.set(id,object)
        const record=this.refs.get(object)
        if(record)record.active=true
        return object
    }
    release(object){
        const record=object&&this.refs.get(object)
        if(record)record.active=false
        return object
    }
    async has(id){if(typeof id!=='string')return false;if(super.has(id))return true;try{await access(this.local.leafPath(id));return true}catch(error){if(error.code==='ENOENT')return false;throw error}}
    async get(id){
        if(typeof id!=='string'||!id)return undefined
        let object=super.get(id)
        if(!object){
            let source
            try{source=await readFile(this.local.leafPath(id),'utf8')}catch(error){if(error.code==='ENOENT')return undefined;throw error}
            const data=JSON.parse(source)
            object=(await this.restore?.(data,id))??createLeaf(data.object,data.object.root!=='object')
            if(!residentHas(this,id))this.set(id,object)
            this.reads++
            object=super.get(id)??object
        }
        const record=object&&this.refs.get(object)
        if(record)this.touch(record)
        return object
    }
    reference(id){return super.get(id)}
    delete(id){
        if(typeof id!=='string'||!id)return super.delete(id)
        const object=super.get(id),record=object&&this.refs.get(object)
        this.dirty.delete(id)
        if(record){this.remove(record);record.object=null}
        return super.delete(id)
    }
    get totalSize(){let total=this.size;for(const id of this.files())if(!residentHas(this,id))total++;return total}
    async count(){let total=this.size;for(const name of await readdir(this.local.leafDirectory)){if(!name.endsWith('.json'))continue;const id=Buffer.from(name.slice(0,-5),'hex').toString();if(!residentHas(this,id))total++}return total}
    async persistAll(){
        let count=0
        for(const [id,object] of super.entries()){
            if(typeof object?.getFile!=='function')continue
            if(await this.withWriteLock(id,async()=>{
                if(super.get(id)!==object)return false
                const path=this.local.leafPath(id),temp=temporaryPath(path)
                try{await writeFile(temp,(await object.getFile()).content);if(super.get(id)!==object)return false;await rename(temp,path);this.dirty.delete(id);this.writes++;return true}
                finally{await unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error})}
            }))count++
        }
        return count
    }
    async persistDirty(){
        let count=0
        for(const [id,object] of this.dirty){
            if(await this.withWriteLock(id,async()=>{
                if(super.get(id)!==object||this.dirty.get(id)!==object)return false
                const path=this.local.leafPath(id),temp=temporaryPath(path)
                try{
                    await writeFile(temp,(await object.getFile()).content)
                    if(super.get(id)!==object||this.dirty.get(id)!==object)return false
                    await rename(temp,path)
                    if(super.get(id)!==object||this.dirty.get(id)!==object){await unlink(path).catch(error=>{if(error.code!=='ENOENT')throw error});return false}
                    this.dirty.delete(id);this.writes++;return true
                }finally{await unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error})}
            }))count++
        }
        return count
    }
    async *references(){
        yield* super.values()
        for(const name of await readdir(this.local.leafDirectory))if(name.endsWith('.json')){
            const id=Buffer.from(name.slice(0,-5),'hex').toString()
            if(residentHas(this,id))continue
            const data=JSON.parse(await readFile(this.local.leafPath(id),'utf8'))
            if(data?.object)yield data.object
        }
    }
    async *values(){
        yield* super.values()
        for(const name of await readdir(this.local.leafDirectory))if(name.endsWith('.json')){
            const id=Buffer.from(name.slice(0,-5),'hex').toString()
            if(residentHas(this,id))continue
            const object=await this.get(id)
            if(object)yield object
        }
    }
    hydrate(record){
        const object=record.object
        if(!record.evicted)return object
        const current=super.get(record.id)
        if(current&&current!==object)return current
        const data=JSON.parse(readFileSync(this.local.leafPath(record.id),'utf8'))
        for(const key of Object.keys(data.object)){
            if(Object.getOwnPropertyDescriptor(object,key)?.configurable===false)continue
            Object.defineProperty(object,key,{value:data.object[key],writable:true,enumerable:true,configurable:true})
        }
        record.evicted=false
        super.set(record.id,object)
        this.add(record)
        this.reads++
        return object
    }
    async evictOne(record){
        const object=record.object
        if(!object||record.evicted||this.pending?.has(object)||record.active)return false
        record.active=true
        try{
            return await this.withWriteLock(record.id,async()=>{
                if(record.object!==object||record.evicted||this.pending?.has(object))return false
                const weight=record.viewed,path=this.local.leafPath(record.id),temp=temporaryPath(path)
                try{
                    const content=(await object.getFile()).content
                    await writeFile(temp,content)
                    if(record.object!==object||record.viewed!==weight||this.pending?.has(object)||(await object.getFile()).content!==content)return false
                    await rename(temp,path)
                    this.dirty.delete(record.id)
                    this.writes++
                    for(const entry of residentIndexEntries(object))entry.releaseObject()
                    for(const key of Object.keys(object)){
                        if(!Object.getOwnPropertyDescriptor(object,key).configurable)continue
                        Object.defineProperty(object,key,{
                            enumerable:true,configurable:true,
                            get(){const live=record.tier.hydrate(record);if(live===object){record.tier.touch(record);return object[key]}return live[key]},
                            set(value){const live=record.tier.hydrate(record);record.tier.touch(record);if(live===object)object[key]=value;else live[key]=value}
                        })
                    }
                    this.remove(record)
                    super.delete(record.id)
                    record.evicted=true
                    return true
                }finally{await unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error})}
            })
        }finally{record.active=false}
    }
    evictBatch(limit,options){
        return this.weights.evictBatch(limit,record=>!!record.object&&!record.evicted&&!record.active&&!this.pending?.has(record.object),record=>this.evictOne(record),options)
    }
    evictLowestWeight(){
        return this.weights.evictLowestWeight(record=>!!record.object&&!record.evicted&&!record.active&&!this.pending?.has(record.object),record=>this.evictOne(record))
    }
    evict(fraction){
        return this.weights.evict(fraction,record=>!!record.object&&!record.evicted&&!record.active&&!this.pending?.has(record.object),record=>this.evictOne(record))
    }
}
