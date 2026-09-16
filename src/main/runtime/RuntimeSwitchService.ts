import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'

export type RuntimeKind = 'electron' | 'browser'

export type RuntimeSwitchStatus = {
  current: RuntimeKind
  target: RuntimeKind
  available: boolean
  message: string
}

export type RuntimeSwitchResult = {
  ok: boolean
  message: string
}

const RUNTIME_HELPER = '/usr/local/sbin/round-carplay-runtime'
const MAX_COMMAND_OUTPUT = 4_000

/**
 * Talks only to the root-owned runtime selector installed with the dual-runtime
 * kiosk. The renderer cannot supply a command, path, service name, or arbitrary
 * argument through this boundary.
 */
export class RuntimeSwitchService {
  async getStatus(current: RuntimeKind): Promise<RuntimeSwitchStatus> {
    const target: RuntimeKind = current === 'electron' ? 'browser' : 'electron'
    const unavailable = (message: string): RuntimeSwitchStatus => ({
      current,
      target,
      available: false,
      message
    })

    if (process.platform !== 'linux') {
      return unavailable('Runtime switching is only available on the Raspberry Pi')
    }

    try {
      await access(RUNTIME_HELPER, constants.X_OK)
    } catch {
      return unavailable('Browser version is not installed yet')
    }

    try {
      const output = await runCommand(RUNTIME_HELPER, ['status', target])
      return {
        current,
        target,
        available: true,
        message: lastOutputLine(output) || `${runtimeLabel(target)} version is ready`
      }
    } catch (error) {
      return unavailable(errorMessage(error))
    }
  }

  async switchTo(current: RuntimeKind, target: RuntimeKind): Promise<RuntimeSwitchResult> {
    if (current === target)
      return { ok: true, message: `${runtimeLabel(target)} is already selected` }
    const status = await this.getStatus(current)
    if (!status.available) return { ok: false, message: status.message }
    if (status.target !== target) return { ok: false, message: 'Invalid runtime switch target' }

    try {
      await runCommand(RUNTIME_HELPER, ['switch', target])
      return { ok: true, message: `${runtimeLabel(target)} version selected for the next boot` }
    } catch (directError) {
      try {
        await runCommand('sudo', ['-n', RUNTIME_HELPER, 'switch', target])
        return { ok: true, message: `${runtimeLabel(target)} version selected for the next boot` }
      } catch (sudoError) {
        return {
          ok: false,
          message: `Could not select the browser version: ${errorMessage(sudoError || directError)}`
        }
      }
    }
  }
}

function runtimeLabel(runtime: RuntimeKind): string {
  return runtime === 'electron' ? 'Electron' : 'Browser'
}

function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      cwd: '/',
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
    child.on('close', (code) => {
      if (code === 0) {
        resolveCommand(output)
        return
      }

      rejectCommand(
        new Error(lastOutputLine(output) || `${command} exited with code ${code ?? 'unknown'}`)
      )
    })
  })
}

function lastOutputLine(output: string): string {
  return (
    output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) ?? ''
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
