import { spawn } from 'node:child_process'
import { createReadStream, type ReadStream } from 'node:fs'
import type { WebContents } from 'electron'

const DEFAULT_DEVICE = '/dev/serial0'
const GPS_BAUD = '9600'
const KNOTS_TO_MPH = 1.150779448
const SPEED_DEAD_ZONE_MPH = 0.75
const SMOOTHING_ALPHA = 0.45
const SIGNAL_TIMEOUT_MS = 5_000

export type GpsState = {
  status: 'connecting' | 'streaming' | 'unavailable' | 'error'
  hasFix: boolean
  speedMph: number | null
  satellites: number
  message: string
}

type ParsedNmea = {
  hasFix?: boolean
  speedKnots?: number
  satellites?: number
}

/**
 * Reads the standard GPS UART exposed by Raspberry Pi OS and publishes a small,
 * renderer-safe state object. The GPS remains useful without gpsd, and keeping
 * this reader in Electron's main process prevents the renderer from touching a
 * Linux character device directly.
 */
export class GpsService {
  private renderer: WebContents | null = null
  private stream: ReadStream | null = null
  private lineBuffer = ''
  private running = false
  private lastSentenceAt = 0
  private signalTimer: NodeJS.Timeout | null = null
  private smoothedSpeedMph: number | null = null
  private state: GpsState = {
    status: process.platform === 'linux' ? 'connecting' : 'unavailable',
    hasFix: false,
    speedMph: null,
    satellites: 0,
    message:
      process.platform === 'linux'
        ? 'Waiting for GPS data'
        : 'GPS is available on the Raspberry Pi build'
  }

  constructor(private readonly devicePath = DEFAULT_DEVICE) {}

  attachRenderer(renderer: WebContents): void {
    this.renderer = renderer
    this.sendState()
  }

  getState(): GpsState {
    return { ...this.state }
  }

  async start(): Promise<void> {
    if (this.running || process.platform !== 'linux') return
    this.running = true
    this.updateState({ status: 'connecting', message: 'Opening GPS receiver' })

    try {
      await configureSerialPort(this.devicePath)
      if (!this.running) return

      const stream = createReadStream(this.devicePath)
      this.stream = stream
      stream.on('data', (chunk) => this.consumeChunk(chunk.toString('utf8')))
      stream.on('error', (error) => {
        if (!this.running) return
        console.error('[GPS] Serial read failed', error)
        this.running = false
        if (this.signalTimer) clearInterval(this.signalTimer)
        this.signalTimer = null
        this.stream = null
        this.updateState({
          status: 'error',
          hasFix: false,
          speedMph: null,
          message: `GPS read failed: ${error.message}`
        })
      })

      this.signalTimer = setInterval(() => this.checkSignalTimeout(), 2_000)
      console.log(`[GPS] Reading ${this.devicePath} at ${GPS_BAUD} baud`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn('[GPS] Could not start GPS service', message)
      this.running = false
      this.updateState({
        status: 'unavailable',
        hasFix: false,
        speedMph: null,
        message
      })
    }
  }

  stop(): void {
    this.running = false
    if (this.signalTimer) clearInterval(this.signalTimer)
    this.signalTimer = null
    this.stream?.destroy()
    this.stream = null
    this.lineBuffer = ''
    this.lastSentenceAt = 0
    this.smoothedSpeedMph = null
  }

  private consumeChunk(chunk: string): void {
    this.lineBuffer += chunk
    const lines = this.lineBuffer.split(/\r?\n/)
    this.lineBuffer = lines.pop() ?? ''

    for (const line of lines) {
      const parsed = parseNmeaSentence(line)
      if (!parsed) continue

      this.lastSentenceAt = Date.now()
      const next: Partial<GpsState> = {
        status: 'streaming',
        message: parsed.hasFix === true ? 'GPS fix acquired' : this.state.message
      }

      if (parsed.satellites != null) next.satellites = parsed.satellites

      if (parsed.hasFix != null) {
        next.hasFix = parsed.hasFix
        if (!parsed.hasFix) {
          next.speedMph = null
          next.message = 'Searching for satellites'
          this.smoothedSpeedMph = null
        }
      }

      if (parsed.hasFix === true && parsed.speedKnots != null) {
        const rawSpeedMph = parsed.speedKnots * KNOTS_TO_MPH
        const speedMph = rawSpeedMph < SPEED_DEAD_ZONE_MPH ? 0 : rawSpeedMph
        this.smoothedSpeedMph =
          this.smoothedSpeedMph == null
            ? speedMph
            : SMOOTHING_ALPHA * speedMph + (1 - SMOOTHING_ALPHA) * this.smoothedSpeedMph
        next.speedMph = this.smoothedSpeedMph
        next.message = 'GPS fix acquired'
      }

      this.updateState(next)
    }
  }

  private checkSignalTimeout(): void {
    if (!this.running) return
    if (this.lastSentenceAt === 0) {
      this.updateState({ status: 'connecting', message: 'Waiting for GPS data' })
      return
    }
    if (Date.now() - this.lastSentenceAt > SIGNAL_TIMEOUT_MS) {
      this.smoothedSpeedMph = null
      this.updateState({
        status: 'error',
        hasFix: false,
        speedMph: null,
        message: 'GPS data stopped'
      })
    }
  }

  private updateState(update: Partial<GpsState>): void {
    const next = { ...this.state, ...update }
    if (JSON.stringify(next) === JSON.stringify(this.state)) return
    this.state = next
    this.sendState()
  }

  private sendState(): void {
    if (this.renderer && !this.renderer.isDestroyed()) {
      this.renderer.send('gps-state', this.getState())
    }
  }
}

export function parseNmeaSentence(line: string): ParsedNmea | null {
  const sentence = line.trim()
  if (!isValidNmeaChecksum(sentence)) return null

  const checksumIndex = sentence.indexOf('*')
  const fields = sentence.slice(1, checksumIndex).split(',')
  const messageType = fields[0].slice(-3)

  if (messageType === 'GGA') {
    const fixQuality = Number(fields[6])
    const satellites = Number(fields[7])
    return {
      hasFix: Number.isFinite(fixQuality) && fixQuality > 0,
      satellites: Number.isFinite(satellites) ? satellites : 0
    }
  }

  if (messageType === 'RMC') {
    const hasFix = fields[2] === 'A'
    const speedKnots = Number(fields[7])
    return {
      hasFix,
      ...(hasFix && Number.isFinite(speedKnots) ? { speedKnots } : {})
    }
  }

  return null
}

function isValidNmeaChecksum(sentence: string): boolean {
  if (!sentence.startsWith('$')) return false
  const checksumIndex = sentence.indexOf('*')
  if (checksumIndex < 0 || checksumIndex + 2 >= sentence.length) return false

  let checksum = 0
  for (let index = 1; index < checksumIndex; index++) {
    checksum ^= sentence.charCodeAt(index)
  }

  const expected = Number.parseInt(sentence.slice(checksumIndex + 1, checksumIndex + 3), 16)
  return Number.isFinite(expected) && checksum === expected
}

function configureSerialPort(devicePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('stty', ['-F', devicePath, GPS_BAUD, 'raw', '-echo'], {
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let errorOutput = ''

    child.stderr.on('data', (chunk) => {
      errorOutput += chunk.toString()
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(errorOutput.trim() || `Could not configure ${devicePath}`))
    })
  })
}
