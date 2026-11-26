import { readFileSync } from 'node:fs'
import { freemem, platform, totalmem } from 'node:os'

/** Match Telemetry's node-level used-memory percentage, including reclaimable memory. */
export function nodeMemory() {
    const total = totalmem()
    let available = freemem()
    if (platform() === 'linux') {
        try {
            const match = readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)/m)
            if (match) available = Number(match[1]) * 1024
        } catch { /* Hosts without procfs use the OS free-memory reading. */ }
    }
    return { total, available, max: (total - available) / total * 100 }
}
