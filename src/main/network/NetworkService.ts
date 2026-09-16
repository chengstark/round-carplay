import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const CAMERA_WIFI_SSID = 'XIAO_ESP32S3_Sense'
const CAMERA_WIFI_HELPER = '/usr/local/sbin/round-carplay-camera-wifi'
const CAMERA_WIFI_RESTORE_HELPER = '/usr/local/sbin/round-carplay-restore-wifi'
const WIFI_CONNECT_HELPER = '/usr/local/sbin/round-carplay-connect-wifi'

export type WifiNetwork = {
  ssid: string
  signal: number
  security: string
  connected: boolean
}

export type IpAddress = {
  interface: string
  address: string
}

export type NetworkSnapshot = {
  available: boolean
  networks: WifiNetwork[]
  ipAddresses: IpAddress[]
  error?: string
}

export type WifiConnectResult = {
  ok: boolean
  message: string
  ipAddresses: IpAddress[]
}

/** NetworkManager bridge for the on-display Wi-Fi picker. */
export class NetworkService {
  private cameraWifiAttempt: Promise<WifiConnectResult> | null = null
  private cameraWifiRestoreAttempt: Promise<WifiConnectResult> | null = null

  connectCameraWifi(): Promise<WifiConnectResult> {
    if (this.cameraWifiAttempt) return this.cameraWifiAttempt

    const attempt = this.connectCameraWifiInternal().finally(() => {
      if (this.cameraWifiAttempt === attempt) this.cameraWifiAttempt = null
    })
    this.cameraWifiAttempt = attempt
    return attempt
  }

  private async connectCameraWifiInternal(): Promise<WifiConnectResult> {
    if (process.platform !== 'linux') {
      return {
        ok: false,
        message: 'Camera Wi-Fi connection is available on Raspberry Pi OS',
        ipAddresses: this.getIpAddresses()
      }
    }

    try {
      if (!existsSync(CAMERA_WIFI_HELPER)) {
        throw new Error('Camera Wi-Fi helper is not installed; rerun the kiosk installer')
      }
      await execFileAsync('sudo', ['-n', CAMERA_WIFI_HELPER], {
        encoding: 'utf8',
        timeout: 35_000,
        maxBuffer: 512 * 1024,
        env: { ...process.env, LC_ALL: 'C' }
      })
      return {
        ok: true,
        message: `Connected to ${CAMERA_WIFI_SSID}`,
        ipAddresses: this.getIpAddresses()
      }
    } catch (error) {
      return {
        ok: false,
        message: commandErrorMessage(error),
        ipAddresses: this.getIpAddresses()
      }
    }
  }

  restoreCameraWifi(): Promise<WifiConnectResult> {
    if (this.cameraWifiRestoreAttempt) return this.cameraWifiRestoreAttempt

    const attempt = this.restoreCameraWifiInternal().finally(() => {
      if (this.cameraWifiRestoreAttempt === attempt) this.cameraWifiRestoreAttempt = null
    })
    this.cameraWifiRestoreAttempt = attempt
    return attempt
  }

  private async restoreCameraWifiInternal(): Promise<WifiConnectResult> {
    if (process.platform !== 'linux') {
      return {
        ok: true,
        message: 'Camera Wi-Fi restoration is not required',
        ipAddresses: this.getIpAddresses()
      }
    }

    try {
      if (!existsSync(CAMERA_WIFI_RESTORE_HELPER)) {
        throw new Error('Camera Wi-Fi restore helper is not installed; rerun the kiosk installer')
      }
      await execFileAsync('sudo', ['-n', CAMERA_WIFI_RESTORE_HELPER], {
        encoding: 'utf8',
        timeout: 35_000,
        maxBuffer: 512 * 1024,
        env: { ...process.env, LC_ALL: 'C' }
      })
      return {
        ok: true,
        message: 'Normal Wi-Fi restored',
        ipAddresses: this.getIpAddresses()
      }
    } catch (error) {
      return {
        ok: false,
        message: commandErrorMessage(error),
        ipAddresses: this.getIpAddresses()
      }
    }
  }

  async scanWifi(): Promise<NetworkSnapshot> {
    if (process.platform !== 'linux') {
      return {
        available: false,
        networks: [],
        ipAddresses: this.getIpAddresses(),
        error: 'Wi-Fi selection is available on Raspberry Pi OS'
      }
    }

    try {
      if (existsSync(CAMERA_WIFI_RESTORE_HELPER)) {
        const restored = await this.restoreCameraWifi()
        if (!restored.ok) throw new Error(restored.message)
      }
      const { stdout } = await runNmcli([
        '--terse',
        '--escape',
        'yes',
        '--fields',
        'IN-USE,SSID,SIGNAL,SECURITY',
        'device',
        'wifi',
        'list',
        '--rescan',
        'yes'
      ])

      return {
        available: true,
        networks: parseWifiList(stdout),
        ipAddresses: this.getIpAddresses()
      }
    } catch (error) {
      return {
        available: false,
        networks: [],
        ipAddresses: this.getIpAddresses(),
        error: commandErrorMessage(error)
      }
    }
  }

  async connectWifi(ssid: string, password: string): Promise<WifiConnectResult> {
    if (process.platform !== 'linux') {
      return {
        ok: false,
        message: 'Wi-Fi selection is available on Raspberry Pi OS',
        ipAddresses: this.getIpAddresses()
      }
    }

    const cleanSsid = ssid.trim()
    if (!cleanSsid) {
      return { ok: false, message: 'Select a Wi-Fi network', ipAddresses: this.getIpAddresses() }
    }

    try {
      if (!existsSync(WIFI_CONNECT_HELPER)) {
        throw new Error('Wi-Fi connection helper is not installed; rerun the kiosk installer')
      }
      await runWifiConnectHelper(cleanSsid, password)
      return {
        ok: true,
        message: `Connected to ${cleanSsid}; password saved for automatic reconnect`,
        ipAddresses: this.getIpAddresses()
      }
    } catch (error) {
      return {
        ok: false,
        message: commandErrorMessage(error),
        ipAddresses: this.getIpAddresses()
      }
    }
  }

  getIpAddresses(): IpAddress[] {
    const addresses: IpAddress[] = []
    const interfaces = networkInterfaces()

    for (const [name, entries] of Object.entries(interfaces)) {
      for (const entry of entries ?? []) {
        if (entry.family === 'IPv4' && !entry.internal) {
          addresses.push({ interface: name, address: entry.address })
        }
      }
    }

    return addresses.sort((a, b) => {
      const aWifi = /^(wlan|wl)/.test(a.interface) ? 0 : 1
      const bWifi = /^(wlan|wl)/.test(b.interface) ? 0 : 1
      return aWifi - bWifi || a.interface.localeCompare(b.interface)
    })
  }
}

function runWifiConnectHelper(ssid: string, password: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'sudo',
      ['-n', WIFI_CONNECT_HELPER],
      {
        encoding: 'utf8',
        timeout: 35_000,
        maxBuffer: 512 * 1024,
        env: { ...process.env, LC_ALL: 'C' }
      },
      (error, _stdout, stderr) => {
        if (!error) {
          resolve()
          return
        }
        const commandError = error as typeof error & { stderr?: string }
        commandError.stderr = stderr
        reject(commandError)
      }
    )

    child.stdin?.on('error', () => {
      // The callback reports helper startup and early-exit errors.
    })
    child.stdin?.end(
      Buffer.concat([
        Buffer.from(ssid, 'utf8'),
        Buffer.from([0]),
        Buffer.from(password, 'utf8'),
        Buffer.from([0])
      ])
    )
  })
}

export function parseWifiList(output: string): WifiNetwork[] {
  const bySsid = new Map<string, WifiNetwork>()

  for (const line of output.split(/\r?\n/)) {
    if (!line) continue
    const [inUse = '', ssid = '', signalText = '0', securityText = ''] = splitNmcliLine(line)
    if (!ssid) continue

    const signal = Math.min(100, Math.max(0, Number(signalText) || 0))
    const network: WifiNetwork = {
      ssid,
      signal,
      security: securityText === '--' ? '' : securityText,
      connected: inUse === '*'
    }
    const existing = bySsid.get(ssid)
    if (!existing || network.connected || network.signal > existing.signal) {
      bySsid.set(ssid, network)
    }
  }

  return [...bySsid.values()].sort(
    (a, b) => Number(b.connected) - Number(a.connected) || b.signal - a.signal
  )
}

function splitNmcliLine(line: string): string[] {
  const fields = ['']
  let escaped = false

  for (const character of line) {
    if (escaped) {
      fields[fields.length - 1] += character
      escaped = false
    } else if (character === '\\') {
      escaped = true
    } else if (character === ':') {
      fields.push('')
    } else {
      fields[fields.length - 1] += character
    }
  }

  if (escaped) fields[fields.length - 1] += '\\'
  return fields
}

function runNmcli(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('nmcli', args, {
    encoding: 'utf8',
    timeout: 35_000,
    maxBuffer: 512 * 1024,
    env: { ...process.env, LC_ALL: 'C' }
  })
}

function commandErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error) {
    const candidate = error as { stderr?: string; message?: string }
    const message = candidate.stderr?.trim() || candidate.message?.trim()
    if (message) return message.replace(/^Error:\s*/i, '')
  }
  return String(error)
}
