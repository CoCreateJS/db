export const STANDARD_SIZES = Object.freeze([10_000, 100_000, 1_000_000])
const supportedSizes = [...STANDARD_SIZES, 200_000].sort((a, b) => a - b)

export function parseStandardSizes(argument) {
    const sizes = (argument ?? STANDARD_SIZES.join(',')).split(',').map(Number)
    if (!sizes.length || sizes.some(size => !supportedSizes.includes(size)))
        throw Error(`Supported dataset sizes are ${supportedSizes.join(', ')}`)
    return sizes
}

export const standardWorkloads = size => {
    const lower = Math.floor(size * 0.4)
    const upper = Math.floor(size * 0.6)
    return {
        equality: { matches: rank => rank % 10 === 3, value: 'group-3' },
        nestedEquality: { matches: rank => rank % 20 === 7, value: 'team-7' },
        numericRange: { lower, upper, matches: rank => rank >= lower && rank < upper },
        and: { group: 'group-4', active: true, matches: rank => rank % 10 === 4 && rank % 2 === 0 },
        or: { groups: ['group-1', 'group-8'], matches: rank => rank % 10 === 1 || rank % 10 === 8 }
    }
}

export function expectedUuids(size, predicate, limit = 100) {
    const ids = []
    for (let rank = 0; rank < size && ids.length < limit; rank++)
        if (predicate(rank)) ids.push(rank.toString(16).padStart(32, '0'))
    return ids
}

export function expectedCount(size, predicate) {
    let count = 0
    for (let rank = 0; rank < size; rank++) if (predicate(rank)) count++
    return count
}

export function createProgressReporter(provider, size, interval = Math.max(10_000, Math.floor(size / 20))) {
    const started = performance.now()
    let reported = 0
    return completed => {
        if (completed !== size && completed - reported < interval) return
        reported = completed
        process.stdout.write(`BENCH_PROGRESS provider=${provider} size=${size} completed=${completed} total=${size} elapsedMs=${(performance.now() - started).toFixed(0)}\n`)
    }
}
