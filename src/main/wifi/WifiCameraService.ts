import { WebContents } from 'electron'
import { execFile } from 'node:child_process'
import http, { ClientRequest, IncomingMessage } from 'node:http'
import { promisify } from 'node:util'
import type { WifiCameraFrameSize, WifiCameraOptions } from '../Globals'

const execFileAsync = promisify(execFile)

const DEFAULT_OPTIONS: WifiCameraOptions = {
  host: '192.168.4.1',
  frameSize: 11,
  jpegQuality: 20,
  horizontalFlip: false
}
const CONTROL_PORT = 80
const STREAM_PORT = 81
const MAX_FRAME_SIZE = 16 * 1024 * 1024
const RECONNECT_DELAY_MS = 1_000
const DIAGNOSTICS_INTERVAL_MS = 1_000
const STALE_STREAM_MS = 2_500
const JPEG_START = Buffer.from([0xff, 0xd8])
const JPEG_END = Buffer.from([0xff, 0xd9])
const SUPPORTED_FRAME_SIZES = new Set<number>([5, 8, 9, 10, 11])

export type CameraState = 'connecting' | 'streaming' | 'error' | 'stopped'

export interface WifiCameraStartResult {
  ok: boolean
  error?: string
}

export interface WifiCameraDiagnostics {
  state: CameraState
  fps: number
  bitrateKbps: number
  frameSizeKb: number
  lastFrameAgeMs: number | null
  receivedFrames: number
  replacedFrames: number
  reconnectCount: number
  interface?: string
  ssid?: string
  signalDbm?: number
  rxBitrateMbps?: number
  txBitrateMbps?: number
  powerSave?: boolean
}

type WifiLinkMetrics = Pick<
  WifiCameraDiagnostics,
  'interface' | 'ssid' | 'signalDbm' | 'rxBitrateMbps' | 'txBitrateMbps' | 'powerSave'
>

/**
 * XIAO ESP32-S3 HTTP camera client used by the round-display UI.
 *
 * The camera exposes ESP32 CameraWebServer controls on port 80 and a multipart
 * MJPEG stream on port 81. Only one JPEG is allowed to be in flight to the
 * renderer; if Chromium is still decoding it, newer complete frames replace
 * the pending frame so latency cannot grow into a backlog. A stalled or closed
 * stream reconnects automatically while the camera surface remains open.
 */
export class WifiCameraService {
  private renderer: WebContents | null = null
  private streamRequest: ClientRequest | null = null
  private streamResponse: IncomingMessage | null = null
  private streamBuffer = Buffer.alloc(0)
  private options: WifiCameraOptions = DEFAULT_OPTIONS
  private running = false
  private starting: Promise<WifiCameraStartResult> | null = null
  private rendererBusy = false
  private pendingFrame: Buffer | null = null
  private receivedFrame = false
  private connectionGeneration = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private diagnosticsTimer: ReturnType<typeof setInterval> | null = null
  private diagnosticsBusy = false
  private state: CameraState = 'stopped'

  private reportStartedAt = Date.now()
  private reportFrames = 0
  private reportBytes = 0
  private currentFps = 0
  private currentBitrateKbps = 0
  private lastFrameAt = 0
  private lastFrameSize = 0
  private receivedFrames = 0
  private replacedFrames = 0
  private reconnectCount = 0
  private connectionStartedAt = 0
  private wifiMetrics: WifiLinkMetrics = {}

  attachRenderer(renderer: WebContents): void {
    this.renderer = renderer
  }

  start(options: WifiCameraOptions): Promise<WifiCameraStartResult> {
    const normalized = normalizeOptions(options)
    if (this.starting) return this.starting
    if (this.running) return this.configure(normalized)

    this.options = normalized
    this.running = true
    this.resetDiagnostics()
    this.startDiagnostics()
    this.starting = this.connectStream(false).finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async connectStream(isReconnect: boolean): Promise<WifiCameraStartResult> {
    this.clearReconnectTimer()
    this.closeTransport()
    if (!this.running) return { ok: false, error: 'Camera start cancelled' }

    const generation = this.connectionGeneration
    this.streamBuffer = Buffer.alloc(0)
    this.rendererBusy = false
    this.pendingFrame = null
    this.receivedFrame = false
    this.connectionStartedAt = Date.now()
    this.lastFrameAt = 0
    this.lastFrameSize = 0
    this.sendStatus(
      'connecting',
      isReconnect
        ? `Reconnecting to XIAO camera at ${this.options.host}…`
        : `Opening XIAO camera at ${this.options.host}…`
    )

    try {
      // The live tuning panel already changes sensor settings during an active
      // stream, so startup can safely do the same. Frame delivery is event-driven
      // and does not wait for the saved controls to finish.
      await Promise.all([this.openStream(generation), this.applyCameraSettings(this.options)])
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!this.running) return { ok: false, error: message }
      if (generation !== this.connectionGeneration) return { ok: true }
      this.closeTransport()
      this.scheduleReconnect(message)
      return { ok: true }
    }
  }

  async configure(options: WifiCameraOptions): Promise<WifiCameraStartResult> {
    const normalized = normalizeOptions(options)
    const hostChanged = normalized.host !== this.options.host
    const imageTuningChanged = normalized.frameSize !== this.options.frameSize ||
      normalized.jpegQuality !== this.options.jpegQuality
    const mirrorChanged = normalized.horizontalFlip !== this.options.horizontalFlip
    this.options = normalized

    if (!this.running) return { ok: true }
    if (hostChanged) {
      return {
        ok: false,
        error: 'Camera address saved. Close and reopen the camera to connect to the new address.'
      }
    }

    try {
      await this.applyCameraSettings(normalized)
      if (this.running) {
        const message = imageTuningChanged
          ? `Camera tuned to ${frameSizeLabel(normalized.frameSize)}`
          : mirrorChanged
            ? `Camera mirror ${normalized.horizontalFlip ? 'enabled' : 'disabled'}`
            : 'Camera settings updated'
        this.sendStatus('streaming', message)
      }
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.sendStatus('error', message)
      return { ok: false, error: message }
    }
  }

  stop(): void {
    this.running = false
    this.clearReconnectTimer()
    this.stopDiagnostics()
    this.closeTransport()
    this.sendStatus('stopped', 'XIAO camera stopped')
  }

  acknowledgeFrame(): void {
    this.rendererBusy = false
    if (!this.running || !this.pendingFrame) return

    const next = this.pendingFrame
    this.pendingFrame = null
    this.deliverFrame(next)
  }

  private closeTransport(): void {
    this.connectionGeneration += 1
    this.streamRequest?.destroy()
    this.streamResponse?.destroy()
    this.streamRequest = null
    this.streamResponse = null
    this.streamBuffer = Buffer.alloc(0)
    this.rendererBusy = false
    this.pendingFrame = null
    this.receivedFrame = false
  }

  private scheduleReconnect(reason: string): void {
    if (!this.running || this.reconnectTimer) return

    this.reconnectCount += 1
    this.sendStatus('connecting', `${reason}. Reconnecting…`)
    this.sendDiagnostics()
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.running) return
      this.starting = this.connectStream(true).finally(() => {
        this.starting = null
      })
    }, RECONNECT_DELAY_MS)
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private async applyCameraSettings(options: WifiCameraOptions): Promise<void> {
    await requestControl(options.host, 'framesize', options.frameSize)
    await requestControl(options.host, 'quality', options.jpegQuality)
    await requestControl(options.host, 'hmirror', options.horizontalFlip ? 1 : 0)
  }

  private openStream(generation: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let opened = false
      const request = http.get(
        {
          hostname: this.options.host,
          port: STREAM_PORT,
          path: '/stream',
          headers: { Accept: 'multipart/x-mixed-replace' }
        },
        (response) => {
          if (!this.running || generation !== this.connectionGeneration) {
            response.destroy()
            reject(new Error('Camera start cancelled'))
            return
          }
          if (response.statusCode !== 200) {
            response.resume()
            reject(new Error(`Camera stream returned HTTP ${response.statusCode ?? 'unknown'}`))
            return
          }

          opened = true
          this.streamResponse = response
          response.on('data', (chunk) => {
            if (this.running && generation === this.connectionGeneration) {
              this.consumeStreamChunk(Buffer.from(chunk), generation)
            }
          })
          response.on('aborted', () => {
            this.handleStreamFailure('Camera stream was interrupted', generation)
          })
          response.on('error', (error) => {
            this.handleStreamFailure(`Camera stream: ${error.message}`, generation)
          })
          response.on('close', () => {
            this.handleStreamFailure('Camera stream connection closed', generation)
          })
          resolve()
        }
      )

      this.streamRequest = request
      request.setTimeout(8_000, () => request.destroy(new Error('Camera connection timed out')))
      request.once('error', (error) => {
        if (!this.running || generation !== this.connectionGeneration) {
          reject(new Error('Camera start cancelled'))
        } else if (!opened) {
          reject(new Error(`Camera connection: ${error.message}`))
        } else {
          this.handleStreamFailure(`Camera connection: ${error.message}`, generation)
        }
      })
    })
  }

  private consumeStreamChunk(chunk: Buffer, generation: number): void {
    this.streamBuffer = Buffer.concat([this.streamBuffer, chunk])

    while (this.streamBuffer.length > 0) {
      const start = this.streamBuffer.indexOf(JPEG_START)
      if (start < 0) {
        this.streamBuffer = this.streamBuffer.at(-1) === 0xff
          ? this.streamBuffer.subarray(-1)
          : Buffer.alloc(0)
        return
      }

      if (start > 0) this.streamBuffer = this.streamBuffer.subarray(start)
      const end = this.streamBuffer.indexOf(JPEG_END, JPEG_START.length)
      if (end < 0) {
        if (this.streamBuffer.length > MAX_FRAME_SIZE) {
          this.handleStreamFailure('Camera JPEG exceeded the maximum frame size', generation)
        }
        return
      }

      const frameEnd = end + JPEG_END.length
      const frame = Buffer.from(this.streamBuffer.subarray(0, frameEnd))
      this.streamBuffer = this.streamBuffer.subarray(frameEnd)
      this.queueFrame(frame)

      if (!this.receivedFrame) {
        this.receivedFrame = true
        this.sendStatus('streaming', `XIAO camera streaming at ${frameSizeLabel(this.options.frameSize)}`)
      }
    }
  }

  private handleStreamFailure(message: string, generation: number): void {
    if (!this.running || generation !== this.connectionGeneration) return
    this.closeTransport()
    this.scheduleReconnect(message)
  }

  private queueFrame(frame: Buffer): void {
    this.lastFrameAt = Date.now()
    this.lastFrameSize = frame.length
    this.receivedFrames += 1
    this.reportFrames += 1
    this.reportBytes += frame.length

    if (this.rendererBusy) {
      if (this.pendingFrame) this.replacedFrames += 1
      this.pendingFrame = frame
      return
    }
    this.deliverFrame(frame)
  }

  private deliverFrame(frame: Buffer): void {
    if (!this.renderer || this.renderer.isDestroyed()) return
    this.rendererBusy = true
    this.renderer.send('wifi-camera-frame', frame)
  }

  private sendStatus(state: CameraState, message: string): void {
    this.state = state
    if (!this.renderer || this.renderer.isDestroyed()) return
    this.renderer.send('wifi-camera-status', { state, message })
  }

  private resetDiagnostics(): void {
    this.reportStartedAt = Date.now()
    this.reportFrames = 0
    this.reportBytes = 0
    this.currentFps = 0
    this.currentBitrateKbps = 0
    this.lastFrameAt = 0
    this.lastFrameSize = 0
    this.receivedFrames = 0
    this.replacedFrames = 0
    this.reconnectCount = 0
    this.connectionStartedAt = Date.now()
    this.wifiMetrics = {}
  }

  private startDiagnostics(): void {
    this.stopDiagnostics()
    this.diagnosticsTimer = setInterval(() => {
      void this.updateDiagnostics()
    }, DIAGNOSTICS_INTERVAL_MS)
    void this.updateDiagnostics()
  }

  private stopDiagnostics(): void {
    if (this.diagnosticsTimer) clearInterval(this.diagnosticsTimer)
    this.diagnosticsTimer = null
  }

  private async updateDiagnostics(): Promise<void> {
    const now = Date.now()
    const elapsed = Math.max(1, now - this.reportStartedAt)
    this.currentFps = (this.reportFrames * 1_000) / elapsed
    this.currentBitrateKbps = (this.reportBytes * 8) / elapsed
    this.reportFrames = 0
    this.reportBytes = 0
    this.reportStartedAt = now

    const frameReference = this.lastFrameAt || this.connectionStartedAt
    if (
      this.running &&
      !this.reconnectTimer &&
      frameReference > 0 &&
      now - frameReference > STALE_STREAM_MS
    ) {
      this.handleStreamFailure('Camera stream stalled', this.connectionGeneration)
    }

    if (!this.diagnosticsBusy) {
      this.diagnosticsBusy = true
      try {
        this.wifiMetrics = await readWifiLink(this.options.host)
      } finally {
        this.diagnosticsBusy = false
      }
    }
    this.sendDiagnostics()
  }

  private sendDiagnostics(): void {
    if (!this.renderer || this.renderer.isDestroyed()) return
    const diagnostics: WifiCameraDiagnostics = {
      state: this.state,
      fps: this.currentFps,
      bitrateKbps: this.currentBitrateKbps,
      frameSizeKb: this.lastFrameSize / 1024,
      lastFrameAgeMs: this.lastFrameAt ? Date.now() - this.lastFrameAt : null,
      receivedFrames: this.receivedFrames,
      replacedFrames: this.replacedFrames,
      reconnectCount: this.reconnectCount,
      ...this.wifiMetrics
    }
    this.renderer.send('wifi-camera-diagnostics', diagnostics)
  }
}

function requestControl(host: string, variable: string, value: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = http.get(
      {
        hostname: host,
        port: CONTROL_PORT,
        path: `/control?var=${encodeURIComponent(variable)}&val=${encodeURIComponent(value)}`
      },
      response => {
        response.resume()
        if (response.statusCode === 200) resolve()
        else reject(new Error(`Camera ${variable} control returned HTTP ${response.statusCode ?? 'unknown'}`))
      }
    )
    request.setTimeout(5_000, () => request.destroy(new Error('Camera control timed out')))
    request.once('error', error => reject(new Error(`Camera control: ${error.message}`)))
  })
}

async function readWifiLink(host: string): Promise<WifiLinkMetrics> {
  if (process.platform !== 'linux') return {}

  try {
    const route = await runCommand('ip', ['route', 'get', host])
    const interfaceName = route.match(/\bdev\s+(\S+)/)?.[1]
    if (!interfaceName) return {}

    const metrics: WifiLinkMetrics = { interface: interfaceName }
    try {
      const link = await runCommand('iw', ['dev', interfaceName, 'link'])
      metrics.ssid = link.match(/^\s*SSID:\s*(.+)$/m)?.[1]?.trim()
      metrics.signalDbm = parseOptionalNumber(link.match(/^\s*signal:\s*(-?[\d.]+)\s*dBm/m)?.[1])
      metrics.rxBitrateMbps = parseOptionalNumber(link.match(/^\s*rx bitrate:\s*([\d.]+)/m)?.[1])
      metrics.txBitrateMbps = parseOptionalNumber(link.match(/^\s*tx bitrate:\s*([\d.]+)/m)?.[1])
    } catch {
      // Keep the route interface even when the wireless driver omits link data.
    }

    try {
      const powerSave = await runCommand('iw', ['dev', interfaceName, 'get', 'power_save'])
      metrics.powerSave = /Power save:\s*on/i.test(powerSave)
    } catch {
      // Power-save reporting is not supported by every wireless driver.
    }
    return metrics
  } catch {
    return {}
  }
}

function runCommand(command: string, args: string[]): Promise<string> {
  return execFileAsync(command, args, {
    encoding: 'utf8',
    timeout: 2_000,
    maxBuffer: 64 * 1024,
    env: { ...process.env, LC_ALL: 'C' }
  }).then((result) => String(result.stdout))
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value == null) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function normalizeOptions(options: Partial<WifiCameraOptions> | null | undefined): WifiCameraOptions {
  return {
    host: normalizeHost(options?.host),
    frameSize: normalizeFrameSize(options?.frameSize),
    jpegQuality: normalizeJpegQuality(options?.jpegQuality),
    horizontalFlip: options?.horizontalFlip === true
  }
}

function normalizeHost(value: unknown): string {
  const candidate = String(value ?? '').trim()
  if (!candidate) return DEFAULT_OPTIONS.host

  try {
    const url = new URL(candidate.includes('://') ? candidate : `http://${candidate}`)
    return url.hostname || DEFAULT_OPTIONS.host
  } catch {
    return DEFAULT_OPTIONS.host
  }
}

function normalizeFrameSize(value: unknown): WifiCameraFrameSize {
  const frameSize = Number(value)
  return SUPPORTED_FRAME_SIZES.has(frameSize) ? frameSize as WifiCameraFrameSize : DEFAULT_OPTIONS.frameSize
}

function normalizeJpegQuality(value: unknown): number {
  const quality = Math.round(Number(value))
  if (!Number.isFinite(quality)) return DEFAULT_OPTIONS.jpegQuality
  return Math.min(63, Math.max(4, quality))
}

function frameSizeLabel(frameSize: WifiCameraFrameSize): string {
  switch (frameSize) {
    case 11: return '1280×720'
    case 10: return '1024×768'
    case 9: return '800×600'
    case 8: return '640×480'
    case 5: return '320×240'
  }
}
