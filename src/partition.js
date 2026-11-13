// Runtime ownership only: byte measurements are never attached to index nodes.
const partitions = new WeakMap()
export const registerPartition = (node, split) => partitions.set(node, split)
export const splitSerializedPartition = (node, bytes) => partitions.get(node)?.(bytes)

// Encode the node once, then insert that exact encoding into the routing frame.
// Routing metadata is not part of the preferred index-node byte target.
export function encodePartitionEnvelope({ value, ...routing }) {
    const node = JSON.stringify(value)
    const header = JSON.stringify(routing)
    return { encoded: `${header.slice(0, -1)}${header.length > 2 ? ',' : ''}"value":${node}}`, bytes: Buffer.byteLength(node) }
}
