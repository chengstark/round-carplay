import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

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

/** Lockout for the Pi radio retained behind the former Bluetooth API shape. */
export class BluetoothService {
  constructor() {
    // CarPlay is display-only: the phone owns the Bluetooth audio connection
    // to the car. Keep the Pi controller off even on devices installed before
    // the kiosk installer began masking bluetooth.service.
    if (process.platform === 'linux') void disableLocalBluetooth()
  }

  async scan(): Promise<BluetoothSnapshot> {
    return { available: false, devices: [], error: 'Pi Bluetooth is disabled (display-only mode)' }
  }

  connect(_address: string): Promise<BluetoothActionResult> {
    return Promise.resolve(disabledAction())
  }

  disconnect(_address: string): Promise<BluetoothActionResult> {
    return Promise.resolve(disabledAction())
  }

}

function disabledAction(): BluetoothActionResult {
  return {
    ok: false,
    available: false,
    devices: [],
    message: 'Pi Bluetooth is disabled; connect the phone directly to the car radio'
  }
}

async function disableLocalBluetooth(): Promise<void> {
  // Powering the controller off disconnects any remembered car radio and
  // prevents BlueZ from auto-connecting it. These commands are best-effort so
  // non-Pi Linux development environments still start normally.
  for (const args of [
    ['discoverable', 'off'],
    ['pairable', 'off'],
    ['power', 'off']
  ]) {
    try {
      await execFileAsync('bluetoothctl', args, {
        encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024
      })
    } catch {
      // The installer also masks BlueZ and rfkill-blocks the controller.
    }
  }

  try {
    await execFileAsync('rfkill', ['block', 'bluetooth'], {
      encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024
    })
  } catch {
    // rfkill normally needs root; bluetoothctl power-off above is sufficient
    // for an existing device until the installer is rerun.
  }
}
