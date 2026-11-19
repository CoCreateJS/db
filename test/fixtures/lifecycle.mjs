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
