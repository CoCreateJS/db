import { createBenchmarkRecord } from '../../../fixtures/lifecycle.mjs'

// Deliberately separate from the v3 provider fixture. Variable nested data makes
// hydration and eviction measurements representative without changing baselines.
export function createResidencyRecord(rank, size, organizationId) {
    const record = createBenchmarkRecord(rank, size, organizationId)
    record.payload = 'x'.repeat(128 + (rank % 8) * 128)
    record.history = Array.from({ length: 1 + rank % 4 }, (_, revision) => ({
        revision,
        actor: `user-${(rank + revision) % 100}`,
        changes: { score: (rank + revision) % 100, active: (rank + revision) % 2 === 0 }
    }))
    return record
}
