import { createHash } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { arch, platform } from 'node:process'
import { join } from 'node:path'

if (platform !== 'linux' || arch !== 'x64') throw Error('The isolated CockroachDB benchmark package currently supports Linux x64 only.')

const version = '26.3.5'
const cache = process.env.COCKROACH_BENCH_CACHE ?? join(process.env.HOME, '.cache/cocreate-db-cockroach', version)
const archiveName = `cockroach-v${version}.linux-amd64.tgz`
const archive = join(cache, archiveName)
const binary = join(cache, 'install/cockroach')
const url = `https://binaries.cockroachdb.com/${archiveName}`
const sha256 = '1033d9ae4727db5f18d62da55b40ef2779765ed94b7bed26892845dedff5b287'
await mkdir(cache, { recursive: true })

async function exists(path) {
    try { await access(path); return true } catch { return false }
}
async function verifiedDownload() {
    try {
        const content = await readFile(archive)
        if (createHash('sha256').update(content).digest('hex') === sha256) return
    } catch {}
    const response = await fetch(url)
    if (!response.ok) throw Error(`CockroachDB download failed: HTTP ${response.status}`)
    const content = Buffer.from(await response.arrayBuffer())
    const actual = createHash('sha256').update(content).digest('hex')
    if (actual !== sha256) throw Error(`CockroachDB package SHA-256 mismatch: ${actual}`)
    await writeFile(archive, content)
}

await verifiedDownload()
if (!await exists(binary)) {
    const install = join(cache, 'install')
    await mkdir(install, { recursive: true })
    execFileSync('tar', ['-xzf', archive, '-C', install, '--strip-components=1'], { stdio: 'inherit' })
}
execFileSync(binary, ['version'], { stdio: 'inherit' })
console.log(`CockroachDB ${version} prepared under ${cache}; no system install was performed.`)
