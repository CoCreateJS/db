import { DiskIndex, restoreIndexEntry } from '../artifact.js'
import {Weights} from './weights.js'
import {unlink,writeFile} from 'node:fs/promises'
import {mkdirSync,writeFileSync,readFileSync,renameSync,unlinkSync} from 'node:fs'
import {join} from 'node:path'
export class LocalTier {
    constructor(directory,resolve,{ resolveArtifact } = {}){this.directory=directory;this.resolve=resolve;this.resolveArtifact=resolveArtifact;this.coldIndexes=new Map();this.weights=new Weights();this.buckets=this.weights;this.active=new Set();this.reads=0;this.writes=0;mkdirSync(directory,{recursive:true})}
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
    evictLowestWeight() {
        if (this.eviction) return this.eviction
        this.eviction = this.weights.evictLowestWeight(p => !!p.entries && !p.indexes && !this.active.has(p),
            p => this.evictOne(p)).finally(() => { this.eviction = null })
        return this.eviction
    }
    drain(maxWeight, fraction) {
        return this.weights.evict(fraction, p => !!p.entries && !p.indexes && !this.active.has(p), p => this.evictOne(p), maxWeight)
    }
    async evictOne(p) {
        if (this.active.has(p) || !p.entries || p.indexes || !this.weights.has(p)) return false
        const weight = p.viewed, revision = p.revision, path = this.path(p), temp = path + '.async.tmp'
        this.active.add(p)
        try {
            await writeFile(temp, p.getFile().content)
            if (p.viewed !== weight || p.revision !== revision || !p.entries || p.indexes || !this.weights.has(p) || !this.canRelease(p)) return false
            renameSync(temp, path)
            this.writes++
            this.release(p)
            return true
        } finally {
            this.active.delete(p)
            await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error })
        }
    }
    canRelease(partition) {
        return !this.resolveArtifact || partition.entries.every(([, entries]) => entries.every(entry => entry.canDetach()))
    }
    release(partition) {
        this.remove(partition)
        if (this.resolveArtifact) {
            const disk = new DiskIndex(this, partition)
            this.coldIndexes.set(partition.uuid, partition)
            for (const [, entries] of partition.entries) {
                for (const entry of entries) entry.detach(disk)
            }
        }
        delete partition.entries
        partition.onDisk = true
    }
    restore(id, partition, value) {
        if (this.resolveArtifact) return restoreIndexEntry(this.resolveArtifact(id), partition, value)
        return this.resolve(id, partition.tree.key)
    }
    relink(partition, entries) {
        if (this.resolveArtifact) {
            for (const [, group] of entries) for (const entry of group) entry.link()
            this.coldIndexes.delete(partition.uuid)
        }
    }
    write(p){const path=this.path(p);writeFileSync(path+'.tmp',p.getFile().content);renameSync(path+'.tmp',path);this.writes++}
    read(p){const data=JSON.parse(readFileSync(this.path(p),'utf8'));this.reads++;return data}
    discard(p){this.remove(p);if(p.onDisk){unlinkSync(this.path(p));this.coldIndexes.delete(p.uuid);p.onDisk=false}}
}
