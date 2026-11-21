import { DiskBranch, restoreIndexEntry } from '../leaf.js'
import {Weights} from './weights.js'
import {unlink,writeFile} from 'node:fs/promises'
import {existsSync,mkdirSync,writeFileSync,readFileSync,readdirSync,renameSync,unlinkSync} from 'node:fs'
import {join} from 'node:path'
export class LocalTier {
    constructor(directory,resolve,{ resolveLeaf } = {}){this.directory=directory;this.branchDirectory=join(directory,'branches');this.leafDirectory=join(directory,'leaves');this.resolve=resolve;this.resolveLeaf=resolveLeaf;this.weights=new Weights();this.buckets=this.weights;this.active=new Set();this.dirty=new Set();this.reads=0;this.writes=0;mkdirSync(this.branchDirectory,{recursive:true});mkdirSync(this.leafDirectory,{recursive:true})}
    get warmBranches(){const local=this;return {get size(){return readdirSync(local.branchDirectory).filter(name=>name.endsWith('.json')).length},has(id){return existsSync(local.branchPath({uuid:id}))},*keys(){for(const name of readdirSync(local.branchDirectory))if(name.endsWith('.json'))yield name.slice(0,-5)}}}
    add(p){this.weights.add(p)}
    remove(p){this.weights.remove(p)}
    touch(p){this.weights.touch(p)}
    leafPath(id){return join(this.leafDirectory,Buffer.from(id).toString('hex')+'.json')}
    async deleteLeaf(id){try{await unlink(this.leafPath(id))}catch(error){if(error.code!=='ENOENT')throw error}}
    branchPath(p){return join(this.branchDirectory,p.uuid+'.json')}
    evict(limit=Infinity,maxWeight=Infinity){let count=0;for(const weight of this.buckets.keys()){if(weight>maxWeight)break;for(const p of this.buckets.get(weight)??[]){if(count>=limit)return count;if(p.toDisk())count++}}return count}
    evictAsync(maxWeight=Infinity,fraction=1){
        if(this.eviction)return this.eviction
        this.eviction=this.drain(maxWeight,fraction).finally(()=>{this.eviction=null})
        return this.eviction
    }
    evictLowestWeight() {
        if (this.eviction) return this.eviction
        this.eviction = this.weights.evictLowestWeight(p => !!p.entries && !p.branches && !this.active.has(p),
            p => this.evictOne(p)).finally(() => { this.eviction = null })
        return this.eviction
    }
    drain(maxWeight, fraction) {
        return this.weights.evict(fraction, p => !!p.entries && !p.branches && !this.active.has(p), p => this.evictOne(p), maxWeight)
    }
    async evictOne(p) {
        if (this.active.has(p) || !p.entries || p.branches || !this.weights.has(p)) return false
        const weight = p.viewed, revision = p.revision, path = this.branchPath(p), temp = path + '.async.tmp'
        this.active.add(p)
        try {
            await writeFile(temp, p.getFile().content)
            if (p.viewed !== weight || p.revision !== revision || !p.entries || p.branches || !this.weights.has(p) || !this.canRelease(p)) return false
            renameSync(temp, path)
            this.writes++
            this.release(p)
            return true
        } finally {
            this.active.delete(p)
            await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error })
        }
    }
    canRelease(index) {
        return !this.resolveLeaf || index.entries.every(([, entries]) => entries.every(entry => entry.canDetach()))
    }
    release(index) {
        this.remove(index)
        const parent=index.parent
        index.parentUuid=parent?.uuid??index.parentUuid??null
        index.previousUuid=index.neighborUuid(-1)??index.previousUuid??null
        index.nextUuid=index.neighborUuid(1)??index.nextUuid??null
        if(parent?.branches){
            const at=parent.branches.indexOf(index)
            if(at>=0)parent.branches[at]=index.reference()
        }
        index.parent=null
        if (this.resolveLeaf) {
            const disk = new DiskBranch(this, index)
            for (const [, entries] of index.entries) {
                for (const entry of entries) entry.detach(disk)
            }
        }
        delete index.entries
        index.onDisk = true
    }
    restore(id, index, value) {
        if (this.resolveLeaf) return restoreIndexEntry(this.resolveLeaf(id), index, value, id)
        return this.resolve(id, index.tree.key)
    }
    write(p){const path=this.branchPath(p);writeFileSync(path+'.tmp',p.getFile().content);renameSync(path+'.tmp',path);this.dirty.delete(p);this.writes++}
    persistDirty(){let count=0;for(const index of [...this.dirty])if(this.weights.has(index)){this.write(index);count++}return count}
    persistAll(){let count=0;for(const [,indexes] of this.weights)for(const index of indexes){this.write(index);count++}return count}
    read(p){return this.readByUuid(p.uuid)}
    readByUuid(id){const data=JSON.parse(readFileSync(join(this.branchDirectory,id+'.json'),'utf8'));this.reads++;return data}
    discard(p){this.remove(p);this.dirty.delete(p);if(p.onDisk){unlinkSync(this.branchPath(p));p.onDisk=false}}
}
