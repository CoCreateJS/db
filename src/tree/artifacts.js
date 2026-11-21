import {Weights} from './weights.js'
import {mkdirSync,readFileSync,renameSync} from 'node:fs'
import {writeFile,unlink} from 'node:fs/promises'
import {join} from 'node:path'
import {bindArtifactTier,residentIndexEntries} from '../artifact.js'
// A cold artifact retains its identity and index entries, not its mutable payload.
export class ArtifactTier extends Map {
    constructor(local){super();this.local=local;this.cold=new Map();this.weights=new Weights();this.buckets=this.weights;this.refs=new WeakMap();this.reads=0;this.writes=0;mkdirSync(join(local.directory,'artifacts'),{recursive:true})}
    add(r){this.weights.add(r)}
    remove(r){this.weights.remove(r)}
    touch(r){if(r.object&&!r.cold)this.weights.touch(r)}
    set(id,object){super.set(id,object);if(object.scope==='object'){let r=this.refs.get(object);if(!r){r={id,object,viewed:0,tier:this};this.refs.set(object,r);this.bind(object,r)}r.object=object;this.add(r)}return this}
    bind(object,r){bindArtifactTier(object,r)}
    has(id){return super.has(id)||this.cold.has(id)}
    get(id){let object=super.get(id);if(!object&&this.cold.has(id))object=this.hydrate(this.cold.get(id));const r=object&&this.refs.get(object);if(r)this.touch(r);return object}
    reference(id){return super.get(id)??this.cold.get(id)?.object}
    delete(id){const object=super.get(id)??this.cold.get(id)?.object,r=object&&this.refs.get(object);if(r){if(r.cold)this.hydrate(r);this.remove(r);r.object=null}return super.delete(id)}
    get totalSize(){return this.size + this.cold.size}
    // Inspect index references without restoring the artifact payload.
    *references(){
        yield* super.values()
        for(const record of this.cold.values())yield record.object
    }
    *values(){yield* super.values();for(const id of [...this.cold.keys()])if(this.cold.has(id))yield this.get(id)}
    hydrate(r){
        const object=r.object
        if(!r.cold)return object
        const data=JSON.parse(readFileSync(this.local.artifactPath(r.id),'utf8'))
        for(const key of Object.keys(data.object)){
            if(Object.getOwnPropertyDescriptor(object,key)?.configurable===false)continue
            Object.defineProperty(object,key,{value:data.object[key],writable:true,enumerable:true,configurable:true})
        }
        for(const entry of residentIndexEntries(object))entry.restoreObject()
        r.cold=false;this.cold.delete(r.id);super.set(r.id,object);this.add(r);this.reads++;return object
    }
    async evictOne(r){
        const object=r.object
        if(!object||r.cold||this.pending?.has(object)||r.active)return false
        r.active=true
        const weight=r.viewed,path=this.local.artifactPath(r.id),temp=path+'.artifact.tmp'
        try{
            const content=object.getFile().content
            await writeFile(temp,content)
            if(r.object!==object||r.viewed!==weight||this.pending?.has(object)||object.getFile().content!==content)return false
            renameSync(temp,path);this.writes++
            for(const entry of residentIndexEntries(object))entry.releaseObject()
            for(const key of Object.keys(object)){
                if(!Object.getOwnPropertyDescriptor(object,key).configurable)continue
                Object.defineProperty(object,key,{enumerable:true,configurable:true,get(){r.tier.hydrate(r);r.tier.touch(r);return object[key]},set(value){r.tier.hydrate(r);r.tier.touch(r);object[key]=value}})
            }
            this.remove(r);super.delete(r.id);r.cold=true;this.cold.set(r.id,r);return true
        }finally{r.active=false;await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e})}
    }
    evictBatch(limit, options) {
        return this.weights.evictBatch(limit, r => !!r.object && !r.cold && !r.active && !this.pending?.has(r.object),
            r => this.evictOne(r), options)
    }
    evict(fraction) {
        return this.weights.evict(fraction, r => !!r.object && !r.cold && !r.active && !this.pending?.has(r.object), r => this.evictOne(r))
    }
}
