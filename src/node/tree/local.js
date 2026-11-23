import { LocalTier as StorageLocalTier } from '../../tree/local-core.js'
import { NodeStorage } from '../storage.js'

export class LocalTier extends StorageLocalTier {
    constructor(directoryOrStorage, resolve, options) {
        super(typeof directoryOrStorage === 'string' ? new NodeStorage(directoryOrStorage) : directoryOrStorage, resolve, options)
    }
}

export default LocalTier
