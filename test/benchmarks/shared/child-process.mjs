import { spawn } from 'node:child_process'

const defaultStallMs = 10 * 60 * 1000

export function launch(args, { cwd, env = process.env, stallMs = Number(process.env.BENCH_STALL_MS ?? defaultStallMs) } = {}) {
    return new Promise(resolve => {
        const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = ''
        let stderr = ''
        let lineBuffer = ''
        let stalled = false
        let timer
        const append = (current, value) => (current + value).slice(-10_000)
        const resetTimer = () => {
            clearTimeout(timer)
            timer = setTimeout(() => {
                stalled = true
                child.kill('SIGTERM')
                const force = setTimeout(() => child.kill('SIGKILL'), 5_000)
                force.unref()
            }, stallMs)
            timer.unref()
        }
        const progress = chunk => {
            lineBuffer += chunk.toString()
            const lines = lineBuffer.split('\n')
            lineBuffer = lines.pop() ?? ''
            for (const line of lines) if (line.startsWith('BENCH_PROGRESS ')) process.stdout.write(`${line}\n`)
        }
        resetTimer()
        child.stdout.on('data', chunk => {
            stdout = append(stdout, chunk.toString())
            progress(chunk)
            resetTimer()
        })
        child.stderr.on('data', chunk => {
            stderr = append(stderr, chunk.toString())
            resetTimer()
        })
        child.on('error', error => {
            clearTimeout(timer)
            resolve({ code: null, signal: null, stdout, stderr: `${stderr}\n${error.message}`, stalled, stallTimeoutMs: stallMs })
        })
        child.on('close', (code, signal) => {
            clearTimeout(timer)
            resolve({ code, signal, stdout, stderr, stalled, stallTimeoutMs: stallMs })
        })
    })
}
