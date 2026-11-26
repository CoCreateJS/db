/** Test/benchmark coordination only; indexing itself runs continuously. */
export async function waitForIndex(resource, { timeoutMs = Number(process.env.BENCH_INDEX_TIMEOUT_MS ?? 30_000), progressMs = Number(process.env.BENCH_INDEX_PROGRESS_MS ?? 0) } = {}) {
    const started = Date.now()
    let lastProgress = started
    while (resource?.pendingIndexCount) {
        const now = Date.now()
        const pending = resource.pendingIndexCount
        if (now - started >= timeoutMs)
            throw new Error(`Index queue did not catch up within ${timeoutMs}ms (${pending} pending)`)
        if (progressMs > 0 && now - lastProgress >= progressMs) {
            process.stdout.write(`BENCH_PROGRESS phase=index-drain elapsedMs=${now - started} pending=${pending}\n`)
            lastProgress = now
        }
        await new Promise(resolve => setImmediate(resolve))
    }
}

export async function waitForCondition(predicate, { timeoutMs = 5_000 } = {}) {
    const started = Date.now()
    while (!predicate()) {
        if (Date.now() - started >= timeoutMs) throw new Error(`Condition was not met within ${timeoutMs}ms`)
        await new Promise(resolve => setImmediate(resolve))
    }
}
