import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readJSON, writeExclusiveJSON } from '../src/storage.js'
import { recordPath } from '../src/files.js'

test('object artifacts persist and retrieve as reusable CoSON frames', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cocreate-coson-artifact-'))
    const organization = 'a'.repeat(24)
    const artifact = 'b'.repeat(32)
    const path = recordPath(join(directory, organization), 'objects', artifact)
    const value = {
        method: 'object.update',
        object: {
            title: 'file payload',
            created: { $date: 1700000000000 },
            content: 'binary[0]',
            binary: [{ $Uint8Array: Uint8Array.from([0, 1, 127, 255]) }]
        }
    }

    try {
        assert.match(path, /\.coson$/)
        await writeExclusiveJSON(path, value)
        const bytes = await readFile(path)
        assert.deepEqual([...bytes.subarray(0, 3)], [0x53, 0x42, 0x43])
        assert.deepEqual(await readJSON(path), value)
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})
