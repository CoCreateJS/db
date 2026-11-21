import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { arch, platform } from 'node:process'

if (platform !== 'linux' || arch !== 'x64') throw Error('The isolated CouchDB 3.5.3 package currently supports Linux x64 only.')

const version = '3.5.3'
const cache = process.env.COUCHDB_BENCH_CACHE ?? join(process.env.HOME, '.cache/cocreate-db-couchdb', version)
const deb = join(cache, `couchdb_${version}~noble_amd64.deb`)
const debUrl = `https://apache.jfrog.io/artifactory/couchdb-deb/pool/C/CouchDB/couchdb_${version}~noble_amd64.deb`
const debSha256 = 'a5870ba7b4ebd2a7d851ecf30d32ab3301c687a0bee0018a76f46b2e10032629'
const packageRoot = join(cache, 'rootfs')
const dependencyRoot = join(cache, 'deps')
const couchdbRoot = join(packageRoot, 'opt/couchdb')
await mkdir(cache, { recursive: true })

async function verifiedDownload(url, path, expected) {
    try {
        const content = await readFile(path)
        if (createHash('sha256').update(content).digest('hex') === expected) return
    } catch {}
    const response = await fetch(url)
    if (!response.ok) throw Error(`Download failed: ${url}: HTTP ${response.status}`)
    const content = Buffer.from(await response.arrayBuffer())
    const actual = createHash('sha256').update(content).digest('hex')
    if (actual !== expected) throw Error(`SHA-256 mismatch for ${url}: ${actual}`)
    await writeFile(path, content)
}

await verifiedDownload(debUrl, deb, debSha256)
if (!await exists(join(couchdbRoot, 'bin/couchdb')))
    execFileSync('dpkg-deb', ['-x', deb, packageRoot], { stdio: 'inherit' })

const dependencyCache = join(cache, 'debs')
const dependencyDeb = join(dependencyCache, 'libmozjs-115-0t64_115.10.0-1_amd64.deb')
const dependencySha256 = 'af3dbc3ff4d082b2d8502586958c8fc0874f36532c218720bf3e53cdf38fcace'
await mkdir(dependencyCache, { recursive: true })
if (!await exists(join(dependencyRoot, 'usr/lib/x86_64-linux-gnu/libmozjs-115.so.0'))) {
    if (!await exists(dependencyDeb)) execFileSync('apt-get', ['download', 'libmozjs-115-0t64=115.10.0-1'], { cwd: dependencyCache, stdio: 'inherit' })
    if (!await exists(dependencyDeb)) throw Error(`Missing downloaded CouchDB runtime dependency: ${dependencyDeb}`)
    const dependencyHash = createHash('sha256').update(await readFile(dependencyDeb)).digest('hex')
    if (dependencyHash !== dependencySha256) throw Error(`SHA-256 mismatch for ${dependencyDeb}: ${dependencyHash}`)
    execFileSync('dpkg-deb', ['-x', dependencyDeb, dependencyRoot], { stdio: 'inherit' })
}

const data = join(cache, 'data')
const views = join(cache, 'index')
const logs = join(cache, 'log')
for (const path of [data, views, logs]) await mkdir(path, { recursive: true })
const username = process.env.COUCHDB_USERNAME ?? 'benchadmin'
const password = process.env.COUCHDB_PASSWORD ?? 'BenchOnlyCouchDB123!'
const port = Number(process.env.COUCHDB_PORT ?? 5984)
const config = [
    '[admins]', `${username} = ${password}`,
    '[chttpd]', 'bind_address = 127.0.0.1', `port = ${port}`,
    '[couchdb]', `database_dir = ${data}`, `view_index_dir = ${views}`,
    '[log]', 'writer = file', `file = ${join(logs, 'couchdb.log')}`,
    ''
].join('\n')
await writeFile(join(cache, 'local.ini'), config)

const ldLibraryPath = join(dependencyRoot, 'usr/lib/x86_64-linux-gnu')
const ldd = execFileSync('ldd', [join(couchdbRoot, 'bin/couchjs')], {
    encoding: 'utf8', env: { ...process.env, LD_LIBRARY_PATH: [ldLibraryPath, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') }
})
if (ldd.includes('not found')) throw Error(`CouchDB runtime dependencies are missing:\n${ldd}`)
console.log(`CouchDB ${version} prepared in ${cache}; system packages were not installed.`)

async function exists(path) {
    try { await access(path); return true } catch { return false }
}
