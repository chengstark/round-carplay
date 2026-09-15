import { WebContents } from 'electron'
import http, { ClientRequest, IncomingMessage } from 'node:http'
import type { WifiCameraFrameSize, WifiCameraOptions } from '../Globals'

const DEFAULT_OPTIONS: WifiCameraOptions = {
  host: '192.168.4.1',
  frameSize: 11,
  jpegQuality: 20
}
const CONTROL_PORT = 80
const STREAM_PORT = 81
const MAX_FRAME_SIZE = 16 * 1024 * 1024
const JPEG_START = Buffer.from([0xff, 0xd8])
const JPEG_END = Buffer.from([0xff, 0xd9])
const SUPPORTED_FRAME_SIZES = new Set<number>([5, 8, 9, 10, 11])

type CameraState = 'connecting' | 'streaming' | 'error' | 'stopped'

export interface WifiCameraStartResult {
  ok: boolean
  error?: string
}

/**
 * XIAO ESP32-S3 HTTP camera client used by the round-display UI.
 *
 * The camera exposes ESP32 CameraWebServer controls on port 80 and a multipart
 * MJPEG stream on port 81. Only one JPEG is allowed to be in flight to the
 * renderer; if Chromium is still decoding it, newer complete frames replace
 * the pending frame so latency cannot grow into a backlog.
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

  attachRenderer(renderer: WebContents): void {
    this.renderer = renderer
  }

  start(options: WifiCameraOptions): Promise<WifiCameraStartResult> {
    const normalized = normalizeOptions(options)
    if (this.starting) return this.starting
    if (this.running) return this.configure(normalized)

    this.options = normalized
    this.starting = this.startInternal().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async startInternal(): Promise<WifiCameraStartResult> {
    this.running = true
    this.rendererBusy = false
    this.pendingFrame = null
    this.streamBuffer = Buffer.alloc(0)
    this.receivedFrame = false
    this.sendStatus('connecting', `Opening XIAO camera at ${this.options.host}…`)

    try {
      // The live tuning panel already changes sensor settings during an active
      // stream, so startup can safely do the same. Open MJPEG immediately while
      // still enforcing the app's saved resolution and quality in parallel.
      // Frame delivery is event-driven and does not wait for Promise.all, which
      // lets the renderer leave the black connecting screen as soon as the first
      // complete JPEG arrives.
      await Promise.all([
        this.openStream(),
        this.applyCameraSettings(this.options)
      ])
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!this.running) return { ok: false, error: message }
      this.cleanup()
      this.sendStatus('error', message)
      return { ok: false, error: message }
    }
  }

  async configure(options: WifiCameraOptions): Promise<WifiCameraStartResult> {
    const normalized = normalizeOptions(options)
    const hostChanged = normalized.host !== this.options.host
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
        this.sendStatus('streaming', `Camera tuned to ${frameSizeLabel(normalized.frameSize)}`)
      }
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.sendStatus('error', message)
      return { ok: false, error: message }
    }
  }

  stop(): void {
    this.cleanup()
    this.sendStatus('stopped', 'XIAO camera stopped')
  }

  acknowledgeFrame(): void {
    this.rendererBusy = false
    if (!this.running || !this.pendingFrame) return

    const next = this.pendingFrame
    this.pendingFrame = null
    this.deliverFrame(next)
  }

  private cleanup(): void {
    this.running = false
    this.streamRequest?.destroy()
    this.streamResponse?.destroy()
    this.streamRequest = null
    this.streamResponse = null
    this.streamBuffer = Buffer.alloc(0)
    this.rendererBusy = false
    this.pendingFrame = null
    this.receivedFrame = false
  }

  private async applyCameraSettings(options: WifiCameraOptions): Promise<void> {
    await requestControl(options.host, 'framesize', options.frameSize)
    await requestControl(options.host, 'quality', options.jpegQuality)
  }

  private openStream(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = http.get(
        {
          hostname: this.options.host,
          port: STREAM_PORT,
          path: '/stream',
          headers: { Accept: 'multipart/x-mixed-replace' }
        },
        response => {
          if (response.statusCode !== 200) {
            response.resume()
            reject(new Error(`Camera stream returned HTTP ${response.statusCode ?? 'unknown'}`))
            return
          }

          this.streamResponse = response
          response.on('data', chunk => {
            if (this.running) this.consumeStreamChunk(Buffer.from(chunk))
          })
          response.on('aborted', () => this.handleStreamFailure('Camera stream was interrupted'))
          response.on('error', error => this.handleStreamFailure(`Camera stream: ${error.message}`))
          response.on('close', () => {
            if (this.running) this.handleStreamFailure('Camera stream connection closed')
          })
          resolve()
        }
      )

      this.streamRequest = request
      request.setTimeout(8_000, () => request.destroy(new Error('Camera connection timed out')))
      request.once('error', error => {
        if (this.starting) reject(new Error(`Camera connection: ${error.message}`))
        else this.handleStreamFailure(`Camera connection: ${error.message}`)
      })
    })
  }

  private consumeStreamChunk(chunk: Buffer): void {
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
          this.handleStreamFailure('Camera JPEG exceeded the maximum frame size')
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

  private handleStreamFailure(message: string): void {
    if (!this.running) return
    this.cleanup()
    this.sendStatus('error', message)
  }

  private queueFrame(frame: Buffer): void {
    if (this.rendererBusy) {
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
    if (!this.renderer || this.renderer.isDestroyed()) return
    this.renderer.send('wifi-camera-status', { state, message })
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

function normalizeOptions(options: Partial<WifiCameraOptions> | null | undefined): WifiCameraOptions {
  return {
    host: normalizeHost(options?.host),
    frameSize: normalizeFrameSize(options?.frameSize),
    jpegQuality: normalizeJpegQuality(options?.jpegQuality)
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
