import {Weights} from './weights.js'
import {unlink,writeFile} from 'node:fs/promises'
import {mkdirSync,writeFileSync,readFileSync,renameSync,unlinkSync} from 'node:fs'
import {join} from 'node:path'
export class LocalTier {
    constructor(directory,resolve){this.directory=directory;this.resolve=resolve;this.weights=new Weights();this.buckets=this.weights;this.active=new Set();this.reads=0;this.writes=0;mkdirSync(directory,{recursive:true})}
    add(p){this.weights.add(p)}
    remove(p){this.weights.remove(p)}
    touch(p){this.weights.touch(p)}
    artifactPath(id){return join(this.directory,'artifacts',Buffer.from(id).toString('hex')+'.json')}
    async deleteArtifact(id){try{await unlink(this.artifactPath(id))}catch(error){if(error.code!=='ENOENT')throw error}}
    path(p){return join(this.directory,p.uuid+'.json')}
    evict(limit=Infinity,maxWeight=Infinity){let count=0;for(const weight of this.buckets.keys()){if(weight>maxWeight)break;for(const p of this.buckets.get(weight)??[]){if(count>=limit)return count;if(p.toDisk())count++}}return count}
    evictAsync(maxWeight=Infinity,fraction=1){
        if(this.eviction)return this.eviction
        this.eviction=this.drain(maxWeight,fraction).finally(()=>{this.eviction=null})
        return this.eviction
    }
    drain(maxWeight, fraction) {
        return this.weights.evict(fraction, p => !!p.entries && !p.indexes && !this.active.has(p), p => this.evictOne(p), maxWeight)
    }
    async evictOne(p) {
        if (this.active.has(p) || !p.entries || p.indexes || !this.weights.has(p)) return false
        const weight = p.viewed, path = this.path(p), temp = path + '.async.tmp'
        this.active.add(p)
        try {
            await writeFile(temp, p.getFile().content)
            if (p.viewed !== weight || !p.entries || p.indexes || !this.weights.has(p)) return false
            renameSync(temp, path)
            this.writes++
            this.remove(p)
            delete p.entries
            p.onDisk = true
            return true
        } finally {
            this.active.delete(p)
            await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error })
        }
    }
    write(p){const path=this.path(p);writeFileSync(path+'.tmp',p.getFile().content);renameSync(path+'.tmp',path);this.writes++}
    read(p){const data=JSON.parse(readFileSync(this.path(p),'utf8'));this.reads++;return data}
    discard(p){this.remove(p);if(p.onDisk){unlinkSync(this.path(p));p.onDisk=false}}
}
