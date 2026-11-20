import { createHash } from 'node:crypto'

export const lifecycleScope = (size = 1) => ({
    organization_id: size.toString(16).padStart(24, '0'),
    storage: 'bench',
    database: 'app',
    array: 'records'
})

export function createLifecycleFixture(size) {
    const organization_id = lifecycleScope(size).organization_id
    return Array.from({ length: size }, (_, rank) => createLifecycleRecord(rank, organization_id))
}

export function createLifecycleRecord(rank, organization_id = lifecycleScope(rank).organization_id) {
    return {
        uuid: rank.toString(16).padStart(32, '0'),
        _id: `item-${String(rank).padStart(6, '0')}`,
        organization_id,
        rank,
        group: `group-${rank % 10}`,
        profile: { team: `team-${rank % 20}`, score: rank % 100 },
        tags: [`tag-${rank % 5}`, `tag-${(rank + 1) % 5}`],
        revision: 0
    }
}

export const benchmarkUuid = rank => rank.toString(16).padStart(32, '0')

export function createBenchmarkRecord(rank, size, organization_id = lifecycleScope(size).organization_id) {
    return {
        uuid: benchmarkUuid(rank),
        _id: `item-${String(rank).padStart(7, '0')}`,
        organization_id,
        rank,
        group: `group-${rank % 10}`,
        active: rank % 2 === 0,
        createdAt: new Date(Date.UTC(2020, 0, 1) + rank * 60_000).toISOString(),
        profile: {
            team: `team-${rank % 20}`,
            score: rank % 100,
            location: { region: `region-${rank % 7}`, verified: rank % 3 === 0 }
        },
        tags: [`tag-${rank % 5}`, `tag-${(rank + 1) % 5}`],
        payload: 'x'.repeat(16 + (rank * 17 % 9) * 16),
        bulkDelete: rank >= size - 25 && rank < size,
        revision: 0
    }
}

export function* benchmarkRecords(size, organization_id = lifecycleScope(size).organization_id) {
    for (let rank = 0; rank < size; rank++)
        yield createBenchmarkRecord(rank, size, organization_id)
}

export function benchmarkFixtureHash(size) {
    const hash = createHash('sha256')
    hash.update('[')
    let first = true
    for (const record of benchmarkRecords(size)) {
        if (!first) hash.update(',')
        hash.update(JSON.stringify(record))
        first = false
    }
    hash.update(']')
    return hash.digest('hex')
}

export function lifecycleFixtureHash(documents) {
    return createHash('sha256').update(JSON.stringify(documents)).digest('hex')
}

export function lifecycleQueries(size) {
    const lower = Math.floor(size * 0.4)
    const upper = Math.floor(size * 0.6)
    return {
        selectedRank: Math.floor(size / 2),
        equality: { query: { group: 'group-3' }, count: Math.max(0, Math.floor((size - 4) / 10) + 1) },
        nested: { query: { 'profile.team': 'team-7' }, count: Math.max(0, Math.floor((size - 8) / 20) + 1) },
        range: { query: { rank: { $gte: lower, $lt: upper } }, count: upper - lower }
    }
}
