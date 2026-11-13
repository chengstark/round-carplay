import { existsSync, readFileSync } from 'node:fs'
import { request } from 'node:http'
import { isIP } from 'node:net'
import { join, resolve } from 'node:path'

export type BrightnessDirection = 'increase' | 'decrease'

export type BrightnessStatus = {
  ok: boolean
  configured: boolean
  active: BrightnessDirection | null
  message: string
}

type ControllerProfile = {
  host: string
  token: string
}

type ControllerState = {
  firmware?: string
  mode?: string
  armed?: boolean
  left?: string
  right?: string
}

const MAX_RESPONSE_BYTES = 16_384
const REQUEST_TIMEOUT_MS = 3_500
const VERIFIED_CONTROLLER_TTL_MS = 15_000
const TAP_ADJUSTMENT_MS = 1_000

/**
 * Authenticated bridge to the XIAO CN5 controller. Credentials stay in the
 * local backend process and are never exposed through the renderer/preload API.
 */
export class BrightnessService {
  private queue: Promise<void> = Promise.resolve()
  private holdStartedAt: number | null = null
  private verifiedController: (ControllerProfile & { checkedAt: number }) | null = null
  private releaseImmediately = false
  private cancelReleaseWait: (() => void) | null = null

  constructor(private readonly userDataPath: string) {}

  getStatus(): Promise<BrightnessStatus> {
    return this.run(async () => {
      const profile = this.loadProfile()
      if (!profile) return notConfigured()

      try {
        const state = await controllerRequest(profile, 'GET', '/status')
        return this.checkController(profile, state)
      } catch (error) {
        this.verifiedController = null
        return {
          ok: false,
          configured: true,
          active: null,
          message: errorMessage(error)
        }
      }
    })
  }

  start(direction: BrightnessDirection): Promise<BrightnessStatus> {
    this.releaseImmediately = false
    return this.run(async () => {
      const profile = this.loadProfile()
      if (!profile) return notConfigured()

      try {
        const verified = this.verifiedController
        if (!verified || verified.host !== profile.host || verified.token !== profile.token ||
            Date.now() - verified.checkedAt >= VERIFIED_CONTROLLER_TTL_MS) {
          const initial = this.checkController(profile, await controllerRequest(profile, 'GET', '/status'))
          if (!initial.ok) return initial
        }
        // ARM already releases both outputs in firmware v5. Validate its reply
        // before START, without another OFF or status round trip on each press.
        const armed = this.checkController(profile, await controllerCommand(profile, 'ARM'))
        if (!armed.ok) {
          await controllerCommand(profile, 'OFF').catch(() => undefined)
          return armed
        }
        const command = direction === 'increase' ? 'LEFT_START' : 'RIGHT_START'
        const state = await controllerCommand(profile, command)
        const status = this.checkController(profile, state)
        if (!status.ok) {
          await controllerCommand(profile, 'OFF').catch(() => undefined)
          return status
        }
        this.holdStartedAt = Date.now()
        return {
          ...status,
          active: direction,
          message: direction === 'increase' ? 'Increasing brightness…' : 'Decreasing brightness…'
        }
      } catch (error) {
        this.verifiedController = null
        this.holdStartedAt = null
        // A lost reply does not prove START failed to reach the controller.
        await controllerCommand(profile, 'OFF').catch(() => undefined)
        return {
          ok: false,
          configured: true,
          active: null,
          message: errorMessage(error)
        }
      }
    })
  }

  stop(immediate = false): Promise<BrightnessStatus> {
    if (immediate) {
      this.releaseImmediately = true
      this.cancelReleaseWait?.()
    }
    return this.run(async () => {
      const profile = this.loadProfile()
      if (!profile) return notConfigured()

      try {
        if (this.holdStartedAt != null && !this.releaseImmediately) {
          const remaining = TAP_ADJUSTMENT_MS - (Date.now() - this.holdStartedAt)
          if (remaining > 0) await new Promise<void>(resolveDelay => {
            const finish = () => {
              clearTimeout(timer)
              this.cancelReleaseWait = null
              resolveDelay()
            }
            const timer = setTimeout(finish, remaining)
            this.cancelReleaseWait = finish
          })
        }
        const state = await controllerCommand(profile, 'OFF')
        this.holdStartedAt = null
        return this.checkController(profile, state)
      } catch (error) {
        this.verifiedController = null
        this.holdStartedAt = null
        return {
          ok: false,
          configured: true,
          active: null,
          message: errorMessage(error)
        }
      }
    })
  }

  private checkController(profile: ControllerProfile, state: ControllerState): BrightnessStatus {
    const status = stateToStatus(state, true)
    this.verifiedController = status.ok ? { ...profile, checkedAt: Date.now() } : null
    return status
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation)
    this.queue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private loadProfile(): ControllerProfile | null {
    const candidates = [
      process.env.CN5_BRIGHTNESS_PROFILE,
      join(this.userDataPath, 'cn5-brightness.json'),
      resolve(process.cwd(), 'firmware/cn5-brightness/.local/wifi-control.json')
    ].filter((candidate): candidate is string => Boolean(candidate))

    for (const path of candidates) {
      if (!existsSync(path)) continue
      try {
        const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<ControllerProfile>
        const host = String(value.host ?? '').trim()
        const token = String(value.token ?? '')
        if (validHost(host) && /^[0-9a-f]{64}$/.test(token)) return { host, token }
      } catch {
        // Continue to the next trusted local profile path.
      }
    }
    return null
  }
}

function notConfigured(): BrightnessStatus {
  return {
    ok: false,
    configured: false,
    active: null,
    message: 'Brightness controller is not configured'
  }
}

function stateToStatus(state: ControllerState, configured: boolean): BrightnessStatus {
  if (state.firmware !== 'v5' || state.mode !== 'DIRECT_OPEN_DRAIN') {
    return {
      ok: false,
      configured,
      active: null,
      message: 'Unexpected brightness-controller firmware'
    }
  }

  const active = state.left === 'PRESSED' ? 'increase' : state.right === 'PRESSED' ? 'decrease' : null
  return {
    ok: true,
    configured,
    active,
    message: active ? (active === 'increase' ? 'Increasing brightness…' : 'Decreasing brightness…') : 'Brightness controller ready'
  }
}

async function controllerCommand(
  profile: ControllerProfile,
  command: string
): Promise<ControllerState> {
  return controllerRequest(profile, 'POST', '/command', command)
}

function controllerRequest(
  profile: ControllerProfile,
  method: 'GET' | 'POST',
  path: string,
  command?: string
): Promise<ControllerState> {
  return new Promise((resolveRequest, rejectRequest) => {
    const body = command == null ? '' : new URLSearchParams({ command }).toString()
    const headers: Record<string, string | number> = {
      Authorization: `Bearer ${profile.token}`,
      Accept: 'application/json'
    }
    if (body) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
      headers['Content-Length'] = Buffer.byteLength(body)
    }

    const req = request(
      {
        hostname: profile.host,
        port: 80,
        method,
        path,
        headers,
        timeout: REQUEST_TIMEOUT_MS
      },
      (response) => {
        let received = 0
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => {
          received += chunk.length
          if (received > MAX_RESPONSE_BYTES) {
            req.destroy(new Error('Brightness-controller response was too large'))
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => {
          const payload = Buffer.concat(chunks).toString('utf8')
          if (response.statusCode !== 200) {
            rejectRequest(new Error(`Brightness controller rejected the request (${response.statusCode ?? 'network error'})`))
            return
          }
          try {
            resolveRequest(JSON.parse(payload) as ControllerState)
          } catch {
            rejectRequest(new Error('Brightness controller returned an invalid response'))
          }
        })
      }
    )

    req.on('timeout', () => req.destroy(new Error('Brightness controller timed out')))
    req.on('error', rejectRequest)
    if (body) req.write(body)
    req.end()
  })
}

function validHost(host: string): boolean {
  if (host === 'cn5-brightness.local') return true
  if (isIP(host) !== 4) return false
  const parts = host.split('.').map(Number)
  return parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Brightness controller unavailable'
}
