import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const BLUETOOTH_HELPER = '/usr/local/sbin/round-carplay-bluetooth'
const ADDRESS_PATTERN = /^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/i

export type BluetoothDevice = {
  address: string
  name: string
  paired: boolean
  trusted: boolean
  connected: boolean
}

export type BluetoothSnapshot = {
  available: boolean
  devices: BluetoothDevice[]
  error?: string
}

export type BluetoothActionResult = BluetoothSnapshot & {
  ok: boolean
  message: string
}

/** BlueZ bridge for discovery and basic pair/connect controls. */
export class BluetoothService {
  async scan(): Promise<BluetoothSnapshot> {
    if (process.platform !== 'linux') {
      return { available: false, devices: [], error: 'Bluetooth is available on Raspberry Pi OS' }
    }

    try {
      this.requireHelper()
      return { available: true, devices: await this.listDevices(true) }
    } catch (error) {
      return { available: false, devices: [], error: commandErrorMessage(error) }
    }
  }

  connect(address: string): Promise<BluetoothActionResult> {
    return this.runAction('connect', address)
  }

  disconnect(address: string): Promise<BluetoothActionResult> {
    return this.runAction('disconnect', address)
  }

  private async runAction(
    action: 'connect' | 'disconnect',
    address: string
  ): Promise<BluetoothActionResult> {
    const normalized = address.trim().toUpperCase()
    if (!ADDRESS_PATTERN.test(normalized)) {
      return { ok: false, available: true, devices: [], message: 'Invalid Bluetooth address' }
    }
    if (process.platform !== 'linux') {
      return {
        ok: false,
        available: false,
        devices: [],
        message: 'Bluetooth is available on Raspberry Pi OS'
      }
    }

    try {
      this.requireHelper()
      await runHelper([action, normalized], action === 'connect' ? 55_000 : 20_000)
      return {
        ok: true,
        available: true,
        devices: await this.listDevices(false),
        message: action === 'connect' ? 'Bluetooth device connected' : 'Bluetooth device disconnected'
      }
    } catch (error) {
      let devices: BluetoothDevice[] = []
      try {
        devices = await this.listDevices(false)
      } catch {
        // Keep the original action error.
      }
      return {
        ok: false,
        available: true,
        devices,
        message: commandErrorMessage(error)
      }
    }
  }

  private async listDevices(activeScan: boolean): Promise<BluetoothDevice[]> {
    const { stdout } = await runHelper([activeScan ? 'scan' : 'list'], activeScan ? 25_000 : 10_000)
    const listed = parseDeviceList(stdout)
    const devices: BluetoothDevice[] = []

    for (const device of listed) {
      try {
        const detail = await runHelper(['info', device.address], 10_000)
        devices.push(parseDeviceInfo(detail.stdout, device))
      } catch {
        devices.push({ ...device, paired: false, trusted: false, connected: false })
      }
    }

    return devices.sort(
      (a, b) => Number(b.connected) - Number(a.connected) ||
        Number(b.paired) - Number(a.paired) ||
        a.name.localeCompare(b.name)
    )
  }

  private requireHelper(): void {
    if (!existsSync(BLUETOOTH_HELPER)) {
      throw new Error('Bluetooth helper is not installed; rerun the kiosk installer')
    }
  }
}

export function parseDeviceList(output: string): Array<Pick<BluetoothDevice, 'address' | 'name'>> {
  const devices = new Map<string, Pick<BluetoothDevice, 'address' | 'name'>>()
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^Device\s+([0-9A-F]{2}(?::[0-9A-F]{2}){5})\s+(.+)$/i)
    if (!match) continue
    const address = match[1].toUpperCase()
    devices.set(address, { address, name: match[2].trim() || address })
  }
  return [...devices.values()]
}

function parseDeviceInfo(
  output: string,
  fallback: Pick<BluetoothDevice, 'address' | 'name'>
): BluetoothDevice {
  const value = (key: string): string | undefined =>
    output.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, 'mi'))?.[1]?.trim()

  return {
    address: fallback.address,
    name: value('Name') || value('Alias') || fallback.name,
    paired: value('Paired') === 'yes',
    trusted: value('Trusted') === 'yes',
    connected: value('Connected') === 'yes'
  }
}

function runHelper(args: string[], timeout: number): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('sudo', ['-n', BLUETOOTH_HELPER, ...args], {
    encoding: 'utf8',
    timeout,
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
