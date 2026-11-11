import { fileURLToPath } from 'node:url'
import { createDB } from '../src/index.js'

const directory = fileURLToPath(new URL('../example-storage/', import.meta.url))
const db = createDB({ directory, nodeId: 'example-node' })

const created = await db.send({
    method: 'object.create',
    organization_id: 'example-org',
    database: 'example',
    array: 'users',
    object: [
        {
            name: 'Ada',
            age: 31,
            active: true,
            'profile.city': 'Lima',
            tags: ['engineer', 'founder']
        },
        {
            name: 'Mina',
            age: 28,
            active: false,
            'profile.city': 'Quito',
            tags: ['designer']
        }
    ]
})

if (!created.success)
    throw new Error(created.error)

const result = await db.send({
    method: 'object.read',
    database: 'example',
    array: 'users',
    filter: { query: { active: true, 'profile.city': 'Lima' } }
})

if (!result.success)
    throw new Error(result.error)

console.log(`Wrote ${created.object.length} objects under ${directory}`)
console.log(JSON.stringify(result.object, null, 2))
