import { after } from 'node:test'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Disk from '@cocreate/disk'
import sourceDB from '../src/index.js'

let sequence = 0
const directories = new Set()
const instances = new Set()

function testDirectory() {
    const directory = join(tmpdir(), `cocreatedb-test-${process.pid}-${sequence++}`)
    directories.add(directory)
    return directory
}

export async function createDB(server = {}, options = {}) {
    const worker = server?.isPrimary === false || server?.isWorker === true && server?.isPrimary !== true
    const configured = { ...options }
    if (!worker && !configured.disk && !server?.disk) {
        const directory = configured.directory ?? testDirectory()
        directories.add(directory)
        configured.disk = await Disk.init({ directory })
    }
    delete configured.directory
    const db = await sourceDB(server, configured)
    instances.add(db)
    return db
}

export async function flushCreatedDatabases() {
    await Promise.all([...instances].map(db => db.flushDisk?.().catch(() => {})))
}

createDB.init = async (server = {}, options = {}) => {
    const worker = server?.isPrimary === false || server?.isWorker === true && server?.isPrimary !== true
    const configured = { ...options }
    if (!worker && !configured.disk && !server?.disk) {
        const directory = configured.directory ?? testDirectory()
        directories.add(directory)
        configured.disk = await Disk.init({ directory })
    }
    delete configured.directory
    const db = await sourceDB.init(server, configured)
    instances.add(db)
    return db
}

createDB.defaultPath = sourceDB

after(async () => {
    await flushCreatedDatabases()
    await Promise.all([...directories].map(directory => rm(directory, { recursive: true, force: true })))
})

export default createDB
