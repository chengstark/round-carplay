import { execFile } from 'node:child_process'
import { networkInterfaces } from 'node:os'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const CAMERA_WIFI_SSID = 'XIAO_ESP32S3_Sense'
const CAMERA_WIFI_PASSWORD = 'seeedstudio'
const CAMERA_WIFI_INTERFACE = 'wlan0'
const CAMERA_WIFI_PROFILE = 'xiao-camera'

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
      const uuid = await ensureCameraWifiProfile()
      await runNmcli([
        '--wait',
        '30',
        'connection',
        'up',
        'uuid',
        uuid,
        'ifname',
        CAMERA_WIFI_INTERFACE
      ])
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

    const args = ['--wait', '30', 'device', 'wifi', 'connect', cleanSsid]
    if (password) args.push('password', password)

    try {
      await runNmcli(args)
      let profileSaved = true
      try {
        await persistActiveWifiProfile(cleanSsid, password)
      } catch {
        profileSaved = false
      }
      return {
        ok: true,
        message: profileSaved
          ? `Connected to ${cleanSsid}; password saved for automatic reconnect`
          : `Connected to ${cleanSsid}, but NetworkManager could not save automatic reconnect`,
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

async function ensureCameraWifiProfile(): Promise<string> {
  let uuids = await findConnectionUuids(CAMERA_WIFI_PROFILE)
  if (uuids.length === 0) {
    await runNmcli([
      'connection',
      'add',
      'type',
      'wifi',
      'ifname',
      CAMERA_WIFI_INTERFACE,
      'con-name',
      CAMERA_WIFI_PROFILE,
      'ssid',
      CAMERA_WIFI_SSID
    ])
    uuids = await findConnectionUuids(CAMERA_WIFI_PROFILE)
  }
  if (uuids.length === 0) throw new Error('Camera Wi-Fi profile could not be created')

  for (const uuid of uuids) await configureCameraWifiProfile(uuid)
  const activeUuids = await findConnectionUuids(CAMERA_WIFI_PROFILE, true)
  return activeUuids.find(uuid => uuids.includes(uuid)) ?? uuids[0]
}

async function configureCameraWifiProfile(uuid: string): Promise<void> {
  await runNmcli([
    'connection',
    'modify',
    'uuid',
    uuid,
    '802-11-wireless.ssid',
    CAMERA_WIFI_SSID,
    '802-11-wireless.powersave',
    '2',
    '802-11-wireless-security.key-mgmt',
    'wpa-psk',
    '802-11-wireless-security.psk-flags',
    '0',
    '802-11-wireless-security.psk',
    CAMERA_WIFI_PASSWORD,
    'connection.autoconnect',
    'yes',
    'connection.autoconnect-priority',
    '500',
    'connection.autoconnect-retries',
    '0',
    'ipv4.method',
    'auto',
    'ipv6.method',
    'disabled'
  ])
}

async function findConnectionUuids(name: string, activeOnly = false): Promise<string[]> {
  const args = [
    '--terse',
    '--escape',
    'yes',
    '--fields',
    'UUID,NAME',
    'connection',
    'show'
  ]
  if (activeOnly) args.push('--active')
  const { stdout } = await runNmcli(args)
  const matches: string[] = []
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue
    const [uuid, connectionName] = splitNmcliLine(line)
    if (connectionName === name && uuid) matches.push(uuid)
  }
  return matches
}

async function persistActiveWifiProfile(ssid: string, password: string): Promise<void> {
  const { stdout } = await runNmcli([
    '--terse',
    '--escape',
    'no',
    '--fields',
    'UUID,TYPE',
    'connection',
    'show',
    '--active'
  ])
  const activeWifiUuids = stdout
    .split(/\r?\n/)
    .map(line => line.split(':'))
    .filter(([, type]) => type === '802-11-wireless' || type === 'wifi')
    .map(([uuid]) => uuid)
    .filter(Boolean)
  let uuid: string | undefined
  for (const candidate of activeWifiUuids) {
    const profile = await runNmcli([
      '--get-values',
      '802-11-wireless.ssid',
      'connection',
      'show',
      'uuid',
      candidate
    ])
    if (profile.stdout.trim() === ssid) {
      uuid = candidate
      break
    }
  }
  if (!uuid) throw new Error('No active Wi-Fi profile was found')

  const args = [
    'connection',
    'modify',
    'uuid',
    uuid,
    'connection.autoconnect',
    'yes',
    'connection.autoconnect-priority',
    '100',
    'connection.autoconnect-retries',
    '0'
  ]
  if (password) {
    args.push(
      '802-11-wireless-security.psk-flags',
      '0',
      '802-11-wireless-security.psk',
      password
    )
  }
  await runNmcli(args)
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
