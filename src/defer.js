export const defer = callback => typeof globalThis.setImmediate === 'function'
    ? { callback, handle: globalThis.setImmediate(callback), immediate: true }
    : { callback, handle: globalThis.setTimeout(callback, 0), immediate: false }

export const cancelDefer = deferred => {
    if (!deferred) return
    if (deferred.immediate && typeof globalThis.clearImmediate === 'function') globalThis.clearImmediate(deferred.handle)
    else globalThis.clearTimeout(deferred.handle)
}

export const nextTurn = () => new Promise(resolve => defer(resolve))
