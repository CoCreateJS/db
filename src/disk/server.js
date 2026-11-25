import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { access, mkdir, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

let temporaryId = 0
const temporaryPath = path => `${path}.${process.pid}.${temporaryId++}.tmp`

export class ServerStorage {
    constructor(directory = join(homedir(), '.cocreate', 'db')) {
        this.directory = directory
        this.branchDirectory = join(directory, 'branches')
        this.leafDirectory = join(directory, 'leaves')
        this.configPath = join(directory, 'config.json')
    }

    async initialize() {
        await mkdir(this.branchDirectory, { recursive: true })
        await mkdir(this.leafDirectory, { recursive: true })
        return this
    }

    branchPath(id) { return join(this.branchDirectory, `${id}.json`) }
    leafPath(id) { return join(this.leafDirectory, `${Buffer.from(id).toString('hex')}.json`) }

    async readConfig() { return await readFile(this.configPath, 'utf8') }
    readConfigSync() { return readFileSync(this.configPath, 'utf8') }
    async writeConfig(content) { await this.writeAtomic(this.configPath, content) }
    async clear() { await rm(this.directory, { recursive: true, force: true }); await this.initialize() }

    async readBranch(id) { return await readFile(this.branchPath(id), 'utf8') }
    async writeBranch(id, content) { await this.writeAtomic(this.branchPath(id), content) }
    async deleteBranch(id) { await this.remove(this.branchPath(id)) }
    async hasBranch(id) { return await this.hasPath(this.branchPath(id)) }
    hasBranchSync(id) { return existsSync(this.branchPath(id)) }
    async listBranches() { return (await readdir(this.branchDirectory)).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)) }
    listBranchesSync() { return readdirSync(this.branchDirectory).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)) }

    async readLeaf(id) { return await readFile(this.leafPath(id), 'utf8') }
    readLeafSync(id) { return readFileSync(this.leafPath(id), 'utf8') }
    async writeLeaf(id, content) { await this.writeAtomic(this.leafPath(id), content) }
    async deleteLeaf(id) { await this.remove(this.leafPath(id)) }
    async hasLeaf(id) { return await this.hasPath(this.leafPath(id)) }
    hasLeafSync(id) { return existsSync(this.leafPath(id)) }
    async listLeaves() { return (await readdir(this.leafDirectory)).filter(name => name.endsWith('.json')).map(name => Buffer.from(name.slice(0, -5), 'hex').toString()) }
    listLeavesSync() { return readdirSync(this.leafDirectory).filter(name => name.endsWith('.json')).map(name => Buffer.from(name.slice(0, -5), 'hex').toString()) }

    async writeAtomic(path, content) {
        const temporary = temporaryPath(path)
        try { await writeFile(temporary, content); await rename(temporary, path) }
        finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
    }

    async remove(path) { await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error }) }
    async hasPath(path) {
        try { await access(path); return true }
        catch (error) { if (error.code === 'ENOENT') return false; throw error }
    }
}

export default ServerStorage
