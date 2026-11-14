import { isDeepStrictEqual } from 'node:util'

// Internal records and index nodes have one owner and are passed by reference.
const targets = new WeakMap()
export const live = value => targets.get(value) ?? value

export function replaceLive(target, source) {
    target = live(target)
    source = live(source)
    if (target === source) return target
    for (const key of Object.keys(target)) if (!Object.hasOwn(source, key)) delete target[key]
    for (const key of Object.keys(source)) target[key] = live(source[key])
    if (Array.isArray(target)) target.length = source.length
    return target
}

/** Validate with the shared update utility before attaching any changes.
 * The view retains only changed property slots, not copies of objects or nodes.
 */
export function prepareMutation(record) {
    const slots = new WeakMap(), views = new WeakMap(), actions = []
    const changes = target => {
        if (!slots.has(target)) slots.set(target, new Map())
        return slots.get(target)
    }
    const get = (target, key) => {
        const change = slots.get(target)?.get(key)
        return change ? change.deleted ? undefined : change.value : target[key]
    }
    const stage = (target, key, value, deleted = false) => {
        changes(target).set(key, { value, deleted })
        actions.push({ target, key, value, deleted })
    }
    const view = value => {
        value = live(value)
        if (!value || typeof value !== 'object') return value
        if (views.has(value)) return views.get(value)
        const proxy = new Proxy(value, {
            get: (target, key) => view(get(target, key)),
            has: (target, key) => slots.get(target)?.has(key) ? !slots.get(target).get(key).deleted : key in target,
            ownKeys(target) {
                const keys = new Set(Reflect.ownKeys(target))
                for (const [key, change] of slots.get(target) ?? []) {
                    if (change.deleted) keys.delete(key)
                    else keys.add(key)
                }
                return [...keys]
            },
            getOwnPropertyDescriptor(target, key) {
                const change = slots.get(target)?.get(key)
                if (!change) return Object.getOwnPropertyDescriptor(target, key)
                if (change.deleted) return undefined
                return { ...(Object.getOwnPropertyDescriptor(target, key) ?? { configurable: true, enumerable: true, writable: true }), value: change.value }
            },
            set(target, key, value) {
                value = live(value)
                const current = get(target, key)
                if (Object.is(current, value) && (Object.hasOwn(target, key) || slots.get(target)?.has(key))) return true
                if (Array.isArray(current) && Array.isArray(value)) {
                    const array = view(current)
                    for (let i = 0; i < value.length; i++) array[i] = live(value[i])
                    array.length = value.length
                    return true
                }
                if (Array.isArray(target)) {
                    if (key === 'length') {
                        for (let i = Number(value); i < get(target, 'length'); i++) stage(target, String(i), undefined, true)
                    } else if (/^(0|[1-9]\d*)$/.test(String(key)) && Number(key) >= get(target, 'length'))
                        stage(target, 'length', Number(key) + 1)
                }
                stage(target, key, value)
                return true
            },
            deleteProperty(target, key) {
                if (key in target || slots.get(target)?.has(key)) {
                    stage(target, key, undefined, true)
                }
                return true
            }
        })
        targets.set(proxy, value)
        views.set(value, proxy)
        return proxy
    }
    return { value: view(record), get changed() {
        return actions.some(({ target, key }) => {
            const change = slots.get(target).get(key)
            return change.deleted ? Object.hasOwn(target, key) :
                !Object.hasOwn(target, key) || !isDeepStrictEqual(target[key], change.value)
        })
    }, commit() {
        for (const { target, key, value, deleted } of actions)
            if (deleted) Reflect.deleteProperty(target, key)
            else Reflect.set(target, key, value)
    } }
}
