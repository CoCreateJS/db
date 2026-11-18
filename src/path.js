import { isAbsolute, resolve } from 'node:path'

const resolvedPaths = new Map()
const maxCachedPaths = 8192

/** Absolute artifact paths repeat heavily during index and persistence work. */
export function resolvePath(path) {
    if (isAbsolute(path) && resolvedPaths.has(path)) return resolvedPaths.get(path)
    const resolved = resolve(path)
    if (isAbsolute(path)) {
        if (resolvedPaths.size >= maxCachedPaths) resolvedPaths.delete(resolvedPaths.keys().next().value)
        resolvedPaths.set(path, resolved)
    }
    return resolved
}
