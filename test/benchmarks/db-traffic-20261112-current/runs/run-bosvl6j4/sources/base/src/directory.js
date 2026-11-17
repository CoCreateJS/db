import path from 'node:path'

/** Resolve a configured CoCreateDB directory, defaulting to the process CWD. */
export function resolveDirectory({ directory, cwd = process.cwd() } = {}) {
    return path.resolve(cwd, process.env.COCREATE_DB_DIRECTORY || directory || '.')
}
