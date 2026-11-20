import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const version = '8.10.3'
const packageVersion = '8.10.3-1rl1~noble1'
const checksum = '2f531d1d8d16ee592a6fe9f18ab8d9f0565440de6b6e1a3be764f0ef876dd57d'
const here = dirname(fileURLToPath(import.meta.url))
const root = process.env.REDIS_SERVER_DIR ?? join(homedir(), '.cache/cocreate-db-redis/8.10.3/extracted/server/usr')
const binary = join(root, 'bin/redis-server')
try {
    const text = execFileSync(binary, ['--version'], { encoding: 'utf8' })
    if (text.includes(`v=${version} `)) process.exit(0)
} catch {}
if (process.platform !== 'linux' || process.arch !== 'x64') throw Error('The isolated Redis package downloader currently supports Ubuntu 24.04 x86_64 only; set REDIS_SERVER_DIR to a compatible Redis 8.10.3 root.')
const cache = join(homedir(), '.cache/cocreate-db-redis/8.10.3')
const deb = join(cache, `redis-server_${packageVersion}_amd64.deb`)
await mkdir(cache, { recursive: true })
const response = await fetch(`https://packages.redis.io/deb/pool/noble/r/re/redis-server_${packageVersion}_amd64.deb`)
if (!response.ok) throw Error(`Redis package download failed: HTTP ${response.status}`)
const data = Buffer.from(await response.arrayBuffer())
if (createHash('sha256').update(data).digest('hex') !== checksum) throw Error('Redis server package SHA-256 did not match the published package checksum')
await writeFile(deb, data)
await mkdir(join(cache, 'extracted/server'), { recursive: true })
execFileSync('dpkg-deb', ['-x', deb, join(cache, 'extracted/server')], { stdio: 'inherit' })
const actual = execFileSync(binary, ['--version'], { encoding: 'utf8' })
if (!actual.includes(`v=${version} `)) throw Error(`Downloaded Redis server version mismatch: ${actual.trim()}`)
console.log(`redisServer=${actual.trim()}`)
