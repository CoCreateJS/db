import {Weights} from '../../tree/weights.js'
import {existsSync,mkdirSync,readFileSync,readdirSync,renameSync,writeFileSync} from 'node:fs'
import {writeFile,unlink} from 'node:fs/promises'
import {bindLeafTier,createLeaf,residentIndexEntries} from '../../leaf.js'

const residentHas = (tier,id) => Map.prototype.has.call(tier,id)

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
        this.reads=0
        this.writes=0
        mkdirSync(local.leafDirectory,{recursive:true})
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
    has(id){return typeof id==='string'&&(super.has(id)||existsSync(this.local.leafPath(id)))}
    get(id){
        if(typeof id!=='string'||!id)return undefined
        let object=super.get(id)
        if(!object&&existsSync(this.local.leafPath(id))){
            const data=JSON.parse(readFileSync(this.local.leafPath(id),'utf8'))
            object=this.restore?.(data,id)??createLeaf(data.object,data.object.root!=='object')
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
    persistAll(){
        let count=0
        for(const [id,object] of super.entries()){
            if(typeof object?.getFile!=='function')continue
            const path=this.local.leafPath(id),temp=path+'.leaf.tmp'
            writeFileSync(temp,object.getFile().content)
            renameSync(temp,path)
            this.dirty.delete(id)
            this.writes++
            count++
        }
        return count
    }
    persistDirty(){
        let count=0
        for(const [id,object] of this.dirty){
            if(super.get(id)!==object)continue
            const path=this.local.leafPath(id),temp=path+'.leaf.tmp'
            writeFileSync(temp,object.getFile().content)
            renameSync(temp,path)
            this.dirty.delete(id)
            this.writes++
            count++
        }
        return count
    }
    *references(){
        yield* super.values()
        for(const id of this.files())if(!residentHas(this,id)){
            const data=JSON.parse(readFileSync(this.local.leafPath(id),'utf8'))
            if(data?.object)yield data.object
        }
    }
    *values(){
        yield* super.values()
        for(const id of this.files())if(!residentHas(this,id)){
            const object=this.get(id)
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
        const weight=record.viewed,path=this.local.leafPath(record.id),temp=path+'.leaf.tmp'
        try{
            const content=object.getFile().content
            await writeFile(temp,content)
            if(record.object!==object||record.viewed!==weight||this.pending?.has(object)||object.getFile().content!==content)return false
            renameSync(temp,path)
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
        }finally{
            record.active=false
            await unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error})
        }
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
