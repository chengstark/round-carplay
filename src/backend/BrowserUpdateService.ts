import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { SystemUpdateStatus } from '../main/update/SystemUpdateService'

type StatusListener = (status: SystemUpdateStatus) => void
const MAX_OUTPUT = 12_000

export class BrowserUpdateService {
  private running = false
  private status: SystemUpdateStatus = {
    state: 'idle',
    message: 'Check for browser updates'
  }

  getStatus(): SystemUpdateStatus {
    return { ...this.status }
  }

  async update(listener: StatusListener): Promise<SystemUpdateStatus> {
    if (this.running) return this.getStatus()
    const repository = findRepository()
    if (!repository) return this.publish('error', 'Browser kiosk repository not found', listener)

    this.running = true
    try {
      this.publish('pulling', 'Pulling the latest browser-kiosk code…', listener)
      const branch = (await run('git', ['branch', '--show-current'], repository)).trim()
      if (branch !== 'browser-kiosk') {
        return this.publish(
          'error',
          `Update requires browser-kiosk; currently on ${branch}`,
          listener
        )
      }
      if ((await run('git', ['status', '--porcelain'], repository)).trim()) {
        return this.publish('error', 'Local code changes found; update manually first', listener)
      }
      const before = (await run('git', ['rev-parse', 'HEAD'], repository)).trim()
      await run('git', ['pull', '--ff-only'], repository)
      const after = (await run('git', ['rev-parse', 'HEAD'], repository)).trim()
      if (before === after) return this.publish('no-update', 'Already up to date', listener)

      this.publish('building', 'Building browser backend and web bundle…', listener)
      await run('npm', ['run', 'build:browser'], repository)
      this.publish('installing', 'Activating the browser release…', listener)
      await run('npm', ['run', 'install:browser-release'], repository)
      return this.publish('success', 'Browser update installed. Restart to activate it', listener)
    } catch (error) {
      return this.publish(
        'error',
        `Browser update failed: ${error instanceof Error ? error.message : String(error)}`,
        listener
      )
    } finally {
      this.running = false
    }
  }

  private publish(
    state: SystemUpdateStatus['state'],
    message: string,
    listener: StatusListener
  ): SystemUpdateStatus {
    this.status = { state, message }
    listener(this.getStatus())
    return this.getStatus()
  }
}

function findRepository(): string | null {
  const candidates = [
    process.env.ROUND_CARPLAY_REPO ? resolve(process.env.ROUND_CARPLAY_REPO) : null,
    join(homedir(), 'round-carplay-browser-kiosk'),
    join(homedir(), 'round-carplay'),
    process.cwd()
  ]
  return (
    candidates.find((candidate): candidate is string =>
      Boolean(
        candidate &&
        existsSync(join(candidate, '.git')) &&
        existsSync(join(candidate, 'package.json'))
      )
    ) ?? null
  )
}

function run(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd, env: process.env, shell: false })
    let output = ''
    const append = (chunk: Buffer): void => {
      output = `${output}${chunk.toString('utf8')}`.slice(-MAX_OUTPUT)
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.on('error', rejectRun)
    child.on('close', (code) => {
      if (code === 0) resolveRun(output)
      else {
        const detail = output
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .at(-1)
        rejectRun(new Error(detail || `${command} exited with code ${code ?? 'unknown'}`))
      }
    })
  })
}
