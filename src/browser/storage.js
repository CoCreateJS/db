const encode = value => Array.from(new TextEncoder().encode(value), byte => byte.toString(16).padStart(2, '0')).join('')
const decode = value => {
    const bytes = new Uint8Array(value.match(/.{2}/g)?.map(pair => Number.parseInt(pair, 16)) ?? [])
    return new TextDecoder().decode(bytes)
}
const isMissing = error => error?.name === 'NotFoundError'

function segments(value) {
    const input = String(value ?? '')
    if (/^[\\/]/.test(input)) throw new Error('OPFS database directory must be relative to the origin-private root')
    const parts = input.split(/[\\/]+/).filter(Boolean)
    if (parts.some(part => part === '.' || part === '..')) throw new Error('Invalid OPFS database path')
    return parts
}

export class OPFSStorage {
    constructor(directory = 'CoCreateDB') {
        this.directory = directory
        this.baseSegments = segments(directory)
        if (!this.baseSegments.length) throw new Error('OPFS database directory must be a non-empty relative path')
        this.baseDirectory = undefined
        this.branchDirectory = undefined
        this.leafDirectory = undefined
    }

    async initialize() {
        const storage = globalThis.navigator?.storage
        if (typeof storage?.getDirectory !== 'function') throw new Error('OPFS is unavailable; CoCreateDB requires a secure browser context with Origin Private File System support')
        let directory = await storage.getDirectory()
        for (const name of this.baseSegments) directory = await directory.getDirectoryHandle(name, { create: true })
        this.baseDirectory = directory
        this.branchDirectory = await directory.getDirectoryHandle('branches', { create: true })
        this.leafDirectory = await directory.getDirectoryHandle('leaves', { create: true })
        return this
    }

    async clear() {
        const root = await globalThis.navigator.storage.getDirectory()
        let parent = root
        for (const name of this.baseSegments.slice(0, -1)) {
            try { parent = await parent.getDirectoryHandle(name) }
            catch (error) { if (isMissing(error)) return await this.initialize(); throw error }
        }
        await parent.removeEntry(this.baseSegments.at(-1), { recursive: true }).catch(error => { if (!isMissing(error)) throw error })
        return await this.initialize()
    }

    async readConfig() { return await this.read(this.baseDirectory, 'config.json') }
    async writeConfig(content) { await this.write(this.baseDirectory, 'config.json', content) }
    async readBranch(id) { return await this.read(this.branchDirectory, `${id}.json`) }
    async writeBranch(id, content) { await this.write(this.branchDirectory, `${id}.json`, content) }
    async deleteBranch(id) { await this.remove(this.branchDirectory, `${id}.json`) }
    async hasBranch(id) { return await this.has(this.branchDirectory, `${id}.json`) }
    async listBranches() { return await this.list(this.branchDirectory, name => name.endsWith('.json'), name => name.slice(0, -5)) }
    async readLeaf(id) { return await this.read(this.leafDirectory, `${encode(id)}.json`) }
    async writeLeaf(id, content) { await this.write(this.leafDirectory, `${encode(id)}.json`, content) }
    async deleteLeaf(id) { await this.remove(this.leafDirectory, `${encode(id)}.json`) }
    async hasLeaf(id) { return await this.has(this.leafDirectory, `${encode(id)}.json`) }
    async listLeaves() { return await this.list(this.leafDirectory, name => name.endsWith('.json'), name => decode(name.slice(0, -5))) }

    async read(directory, name) {
        const file = await (await directory.getFileHandle(name)).getFile()
        return await file.text()
    }

    async write(directory, name, content) {
        const handle = await directory.getFileHandle(name, { create: true })
        const stream = await handle.createWritable()
        try { await stream.write(content); await stream.close() }
        catch (error) { try { await stream.abort?.() } catch {} throw error }
    }

    async remove(directory, name) {
        await directory.removeEntry(name).catch(error => { if (!isMissing(error)) throw error })
    }

    async has(directory, name) {
        try { await directory.getFileHandle(name); return true }
        catch (error) { if (isMissing(error)) return false; throw error }
    }

    async list(directory, accepts, map) {
        const values = []
        for await (const [name, handle] of directory.entries())
            if (handle.kind === 'file' && accepts(name)) values.push(map(name))
        return values
    }
}

export default OPFSStorage
