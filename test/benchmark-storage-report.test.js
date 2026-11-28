import test from 'node:test'
import assert from 'node:assert/strict'
import { writeAccounting, storageTables } from './benchmarks/shared/storage-report.mjs'

test('pending writes are reported as outstanding, never as eliminated by coalescing', () => {
    const rows = writeAccounting({
        submittedRequestsByKind: { 'leaf.write': 1000 },
        submittedWriteBytesByKind: { 'leaf.write': 100000 },
        outstandingRequestsByKind: { 'leaf.write': 900 }
    }, { 'leaf.writeFile': { startedCalls: 100, completedCalls: 100, payloadBytesCompleted: 10000 },
        'leaf.rename': { completedCalls: 99 } })
    assert.equal(rows.leaf.submittedWriteRequests, 1000)
    assert.equal(rows.leaf.outstandingWriteRequests, 900)
    assert.equal(rows.leaf.supersededWriteRequests, 0)
    assert.equal(rows.leaf.filesystemWritesCompleted, 100)
    assert.equal(rows.leaf.fileReplacementsCompleted, 99)
    assert.equal('requestReductionPercent' in rows.leaf, false)
    const markdown = storageTables(rows)
    assert.match(markdown, /Requests submitted to Disk, before coalescing/)
    assert.match(markdown, /Filesystem writes after coalescing/)
    assert.match(markdown, /In-memory branch mutation counts are not measured/)
})

test('explicit superseded/cancelled results stay separate from actual file completions', () => {
    const rows = writeAccounting({
        submittedRequestsByKind: { 'branch.write': 10 },
        supersededRequestsByKind: { 'branch.write': 7 },
        cancelledRequestsByKind: { 'branch.write': 1 },
        outstandingRequestsByKind: { 'branch.write': 1 }
    }, { 'branch.writeFile': { startedCalls: 2, completedCalls: 1, payloadBytesCompleted: 512 } })
    assert.equal(rows.branch.supersededWriteRequests, 7)
    assert.equal(rows.branch.cancelledWriteRequests, 1)
    assert.equal(rows.branch.outstandingWriteRequests, 1)
    assert.equal(rows.branch.filesystemWritesStarted, 2)
    assert.equal(rows.branch.filesystemWritesCompleted, 1)
    assert.equal(rows.branch.filesystemWritePayloadBytesCompleted, 512)
})

test('configuration accounting includes roots and catalogs counted by the filesystem probe', () => {
    const rows = writeAccounting({
        submittedRequestsByKind: { 'config.write': 5, 'roots.write': 2 },
        submittedWriteBytesByKind: { 'config.write': 500, 'roots.write': 200 }
    }, { 'config.writeFile': { startedCalls: 7, completedCalls: 7, payloadBytesCompleted: 700 } })
    assert.equal(rows.config.submittedWriteRequests, 7)
    assert.equal(rows.config.submittedWriteBytes, 700)
    assert.equal(rows.config.filesystemWritesCompleted, 7)
})
