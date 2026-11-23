// Keep the source-level Node entry stable for consumers that construct a LocalTier
// from a directory. Browser code imports the storage-agnostic local-core module.
export { LocalTier, default } from '../node/tree/local.js'
