import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export type SystemUpdateState =
  | 'idle'
  | 'pulling'
  | 'building'
  | 'no-update'
  | 'success'
  | 'error'

export type SystemUpdateStatus = {
  state: SystemUpdateState
  message: string
}

export type SystemRebootResult = {
  ok: boolean
  message: string
}

type StatusListener = (status: SystemUpdateStatus) => void

const MAX_COMMAND_OUTPUT = 12_000
const TARGET_BRANCH = 'wisecoco-480'

/**
 * Pulls and builds the fixed round-carplay repository without accepting any
 * command or path from the renderer. This keeps the menu button useful without
 * exposing a general-purpose shell through Electron's preload bridge.
 */
export class SystemUpdateService {
  private running = false
  private status: SystemUpdateStatus = {
    state: 'idle',
    message: 'Check for application updates'
  }

  getStatus(): SystemUpdateStatus {
    return { ...this.status }
  }

  async reboot(): Promise<SystemRebootResult> {
    if (process.platform !== 'linux') {
      return { ok: false, message: 'Reboot is only available on the Raspberry Pi' }
    }

    try {
      await runCommand('systemctl', ['reboot'], process.cwd())
      return { ok: true, message: 'Reboot requested' }
    } catch (systemctlError) {
      try {
        await runCommand('sudo', ['-n', 'systemctl', 'reboot'], process.cwd())
        return { ok: true, message: 'Reboot requested' }
      } catch (sudoError) {
        return {
          ok: false,
          message: `Reboot failed: ${errorMessage(sudoError || systemctlError)}`
        }
      }
    }
  }

  async update(onStatus: StatusListener): Promise<SystemUpdateStatus> {
    if (this.running) return this.getStatus()

    if (process.platform !== 'linux') {
      return this.publish(
        { state: 'error', message: 'Updates can only be built on the Raspberry Pi' },
        onStatus
      )
    }

    const repoPath = findRepository()
    if (!repoPath) {
      return this.publish(
        { state: 'error', message: 'Repository not found at ~/round-carplay' },
        onStatus
      )
    }

    this.running = true

    try {
      this.publish(
        { state: 'pulling', message: `Pulling the latest ${TARGET_BRANCH} code…` },
        onStatus
      )

      let previousCommit: string
      try {
        const branch = (
          await runCommand('git', ['branch', '--show-current'], repoPath)
        ).trim()
        if (branch !== TARGET_BRANCH) {
          return this.publish(
            {
              state: 'error',
              message: `Update requires branch ${TARGET_BRANCH}; currently on ${branch || 'detached HEAD'}`
            },
            onStatus
          )
        }

        const localChanges = (await runCommand('git', ['status', '--porcelain'], repoPath)).trim()
        if (localChanges) {
          return this.publish(
            { state: 'error', message: 'Local code changes found; update manually first' },
            onStatus
          )
        }

        previousCommit = (await runCommand('git', ['rev-parse', 'HEAD'], repoPath)).trim()
        await runCommand('git', ['pull', '--ff-only'], repoPath)
      } catch (error) {
        return this.publish(
          { state: 'error', message: `Pull failed: ${errorMessage(error)}` },
          onStatus
        )
      }

      const currentCommit = (await runCommand('git', ['rev-parse', 'HEAD'], repoPath)).trim()
      if (currentCommit === previousCommit) {
        return this.publish({ state: 'no-update', message: 'Already up to date' }, onStatus)
      }

      this.publish({ state: 'building', message: 'Update pulled. Building the AppImage…' }, onStatus)

      try {
        await runCommand('npm', ['run', 'build:armLinux'], repoPath)
      } catch (error) {
        return this.publish(
          { state: 'error', message: `Build failed: ${errorMessage(error)}` },
          onStatus
        )
      }

      return this.publish(
        { state: 'success', message: 'Build complete. Restart to apply the update' },
        onStatus
      )
    } catch (error) {
      return this.publish(
        { state: 'error', message: `Update failed: ${errorMessage(error)}` },
        onStatus
      )
    } finally {
      this.running = false
    }
  }

  private publish(status: SystemUpdateStatus, listener: StatusListener): SystemUpdateStatus {
    this.status = status
    listener(this.getStatus())
    return this.getStatus()
  }
}

function findRepository(): string | null {
  const configuredPath = process.env.ROUND_CARPLAY_REPO?.trim()
  const candidates = [
    configuredPath ? resolve(configuredPath) : null,
    join(homedir(), 'round-carplay'),
    process.cwd()
  ]

  for (const candidate of candidates) {
    if (
      candidate &&
      existsSync(join(candidate, '.git')) &&
      existsSync(join(candidate, 'package.json'))
    ) {
      return candidate
    }
  }

  return null
}

function runCommand(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolveCommand, rejectCommand) => {
    const executable = process.platform === 'win32' && command === 'npm' ? 'npm.cmd' : command
    const child = spawn(executable, args, {
      cwd,
      env: process.env,
      shell: false
    })
    let output = ''

    const appendOutput = (chunk: Buffer): void => {
      output = `${output}${chunk.toString('utf8')}`.slice(-MAX_COMMAND_OUTPUT)
    }

    child.stdout.on('data', appendOutput)
    child.stderr.on('data', appendOutput)
    child.on('error', rejectCommand)
    child.on('close', code => {
      if (code === 0) {
        resolveCommand(output)
        return
      }

      const detail = lastOutputLine(output) || `${command} exited with code ${code ?? 'unknown'}`
      rejectCommand(new Error(detail))
    })
  })
}

function lastOutputLine(output: string): string {
  return output
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .at(-1) ?? ''
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
