import { readFile, readdir } from 'node:fs/promises'
import { resolve, join, relative, sep } from 'node:path'

const roots = new Set()
const files = new Map()
const inside = (root, file) => file === root || file.startsWith(root + sep)

export async function preloadDirectory(directory) {
    const root = resolve(directory)
    roots.add(root)
    const visit = async path => {
        let entries
        try { entries = await readdir(path, { withFileTypes: true }) }
        catch (error) { if (error.code === 'ENOENT') return; throw error }
        for (const entry of entries) {
            const file = join(path, entry.name)
            if (entry.isDirectory()) await visit(file)
            else if (entry.isFile() && entry.name.endsWith('.json')) {
                const text = await readFile(file, 'utf8')
                try { files.set(resolve(file), JSON.parse(text)) }
                catch (error) { throw new Error(`Invalid JSON in ${relative(root, file)}: ${error.message}`) }
            }
        }
    }
    await visit(root)
    return { files: [...files.keys()].filter(file => inside(root, file)).length }
}

export function memoryEnabled(file) {
    file = resolve(file)
    for (const root of roots) if (inside(root, file)) return true
    return false
}

export async function readMemoryJSON(file) {
    file = resolve(file)
    if (files.has(file)) return structuredClone(files.get(file))
    try {
        const value = JSON.parse(await readFile(file, 'utf8'))
        if (memoryEnabled(file)) files.set(file, value)
        return value
    } catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
}

export function writeMemoryJSON(file, value) {
    file = resolve(file)
    if (memoryEnabled(file)) files.set(file, structuredClone(value))
}

export function removeMemoryPath(path) {
    path = resolve(path)
    for (const file of files.keys()) if (inside(path, file)) files.delete(file)
}

export function memoryStats(directory) {
    const root = resolve(directory)
    const entries = [...files].filter(([file]) => inside(root, file))
    return { files: entries.length, serializedBytes: entries.reduce((sum, [, value]) => sum + Buffer.byteLength(JSON.stringify(value)), 0) }
}
