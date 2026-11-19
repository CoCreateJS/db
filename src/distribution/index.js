import {createPeers} from './peers.js'

export function createDistribution(server) {
    return {peers:createPeers(server),async locate(){return null}}
}
