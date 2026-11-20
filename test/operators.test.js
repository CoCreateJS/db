import assert from 'node:assert/strict'
import test from 'node:test'
import { queryData } from '@cocreate/utils'
import { createArtifact, attach, updateArtifact, type } from '../src/artifact.js'
import { Tree } from '../src/tree/index.js'
import { queryTree } from '../src/tree/query.js'

function indexedScope(records) {
    const scope = { artifacts: new Map(), tree: new Map() }
    for (const record of records) {
        const artifact = createArtifact(structuredClone(record))
        scope.artifacts.set(artifact.uuid, artifact)
        attach(artifact, entry => {
            let types = scope.tree.get(entry.key)
            if (!types) scope.tree.set(entry.key, types = new Map())
            let tree = types.get(type(entry.value))
            if (!tree) types.set(type(entry.value), tree = new Tree(3))
            tree.insert(entry)
        })
    }
    return scope
}

test('artifact creation omits undefined values and indexes null', () => {
    const artifact = createArtifact({ uuid: 'a', value: undefined, nested: { missing: undefined, nil: null } })
    assert.equal(Object.hasOwn(artifact, 'value'), false)
    assert.equal(Object.hasOwn(artifact.nested, 'missing'), false)
    assert.equal(artifact.getIndex('nested.nil')?.value, null)
})

test('artifact updates remove undefined indexes and move type-changed entries', () => {
    const scope = indexedScope([{ uuid: 'a', value: 2 }])
    const artifact = scope.artifacts.get('a')
    const entry = artifact.getIndex('value')
    const numberTree = scope.tree.get('value').get('number')
    assert.equal(entry.partition !== null, true)

    updateArtifact(artifact, { value: '2' })
    assert.equal(artifact.getIndex('value'), entry)
    assert.equal(entry.value, '2')
    assert.equal(entry.tree, scope.tree.get('value').get('string'))
    assert.equal(numberTree.root.length, 0)

    updateArtifact(artifact, { value: undefined })
    assert.equal(Object.hasOwn(artifact, 'value'), false)
    assert.equal(artifact.getIndex('value'), undefined)
    assert.equal(entry.partition, null)
})

test('indexed and full-scan query results match Utils semantics', () => {
    const scope = indexedScope([
        { uuid: 'a', value: 2, data: { x: 1 }, rows: [{ n: 4 }] },
        { uuid: 'b', value: '2', data: { x: 2 }, rows: [{ n: 5 }] },
        { uuid: 'c', value: [2], data: { x: 3 }, rows: [{ n: 6 }] },
        { uuid: 'd', value: 4, data: { x: 4 }, rows: [{ n: 7 }] },
        { uuid: 'e', value: null, data: { x: 5 }, rows: [] }
    ])
    const queries = [
        { value: 2 },
        { value: { $in: [2, [2]] } },
        { value: { $includes: 2 } },
        { value: { $gte: 2, $lt: 4 } },
        { value: { $gte: '1', $lt: 5 } },
        { value: { $ne: 2 } },
        { 'data.x': { $gt: 2 } },
        { 'rows[0].n': { $gte: 5 } },
        { 'rows.n': 5 },
        { $or: [{ value: 2 }, { value: '2' }] },
        { value: { $exists: true } }
    ]

    for (const query of queries) {
        const expected = [...scope.artifacts.values()].filter(artifact => queryData(artifact, query))
            .map(artifact => artifact.uuid).sort()
        const actual = queryTree(scope, query).map(artifact => artifact.uuid).sort()
        assert.deepEqual(actual, expected, JSON.stringify(query))
    }
})
