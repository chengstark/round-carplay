import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Socket } from 'node:net'
import { promisify } from 'node:util'
import { WIFI_CAMERA_RESOLUTIONS, type WifiCameraFrameSize, type WifiCameraOptions } from '../Globals'
import { NULL_EVENT_SINK, type ServiceEventSink } from '../events/ServiceEventSink'

const execFileAsync = promisify(execFile)
const DEFAULT_OPTIONS: WifiCameraOptions = {
  host: '192.168.10.1', frameSize: 8, jpegQuality: 20, horizontalFlip: false
}
const CONTROL_PORT = 2222
const MEDIA_PORT = 2223
const XMIP_MAGIC = Buffer.from('XMIP')
const XMIP_HEADER_SIZE = 9
const MAX_PAYLOAD_SIZE = 16 * 1024 * 1024
const RECONNECT_DELAY_MS = 1_000
const DIAGNOSTICS_INTERVAL_MS = 1_000
const HEARTBEAT_INTERVAL_MS = 2_000
const STALE_STREAM_MS = 3_500
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
  noiseDbm?: number
  rxBitrateMbps?: number
  txBitrateMbps?: number
  powerSave?: boolean
}

type WifiLinkMetrics = Pick<WifiCameraDiagnostics,
  'interface' | 'ssid' | 'signalDbm' | 'noiseDbm' | 'rxBitrateMbps' | 'txBitrateMbps' | 'powerSave'>

/**
 * E-Eye XMIP camera client. Control JSON is framed over TCP 2222 and H.265
 * access units arrive over TCP 2223. ffmpeg decodes to an MJPEG pipe so both
 * shells keep the existing JPEG event contract and browser Chromium does not
 * need native HEVC support.
 */
export class WifiCameraService {
  private controlSocket: Socket | null = null
  private mediaSocket: Socket | null = null
  private decoder: ChildProcessWithoutNullStreams | null = null
  private controlBuffer = Buffer.alloc(0)
  private mediaBuffer = Buffer.alloc(0)
  private jpegBuffer = Buffer.alloc(0)
  private decoderError = ''
  private decoderBackpressured = false
  private awaitingKeyframe = true
  private expectedSequence: number | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
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

  constructor(private readonly events: ServiceEventSink = NULL_EVENT_SINK) {}

  isActive(): boolean { return this.running }

  start(options: WifiCameraOptions): Promise<WifiCameraStartResult> {
    const normalized = normalizeOptions(options)
    if (this.starting) return this.starting
    if (this.running) return this.configure(normalized)
    this.options = normalized
    this.running = true
    this.resetDiagnostics()
    this.startDiagnostics()
    this.starting = this.connectStream(false).finally(() => { this.starting = null })
    return this.starting
  }

  async configure(options: WifiCameraOptions): Promise<WifiCameraStartResult> {
    const normalized = normalizeOptions(options)
    const transportChanged = normalized.host !== this.options.host ||
      normalized.frameSize !== this.options.frameSize
    this.options = normalized
    if (!this.running || !transportChanged) return { ok: true }
    this.sendStatus('connecting', 'Applying E-Eye stream settings…')
    return this.connectStream(true)
  }

  stop(): void {
    this.running = false
    this.clearReconnectTimer()
    this.stopDiagnostics()
    this.closeTransport()
    this.sendStatus('stopped', 'E-Eye camera stopped')
  }

  acknowledgeFrame(): void {
    this.rendererBusy = false
    if (!this.running || !this.pendingFrame) return
    const next = this.pendingFrame
    this.pendingFrame = null
    this.deliverFrame(next)
  }

  private async connectStream(isReconnect: boolean): Promise<WifiCameraStartResult> {
    this.clearReconnectTimer()
    this.closeTransport()
    if (!this.running) return { ok: false, error: 'Camera start cancelled' }
    const generation = this.connectionGeneration
    this.connectionStartedAt = Date.now()
    this.lastFrameAt = 0
    this.sendStatus('connecting', isReconnect
      ? `Reconnecting to E-Eye camera at ${this.options.host}…`
      : `Opening E-Eye camera at ${this.options.host}…`)

    try {
      const controlSocket = await openSocket(this.options.host, CONTROL_PORT)
      const provisionalControlError = (): void => {}
      controlSocket.on('error', provisionalControlError)
      let mediaSocket: Socket
      try {
        mediaSocket = await openSocket(this.options.host, MEDIA_PORT)
      } catch (error) {
        controlSocket.destroy()
        throw error
      }
      controlSocket.off('error', provisionalControlError)
      if (!this.running || generation !== this.connectionGeneration) {
        controlSocket.destroy()
        mediaSocket.destroy()
        return { ok: false, error: 'Camera start cancelled' }
      }
      this.controlSocket = controlSocket
      this.mediaSocket = mediaSocket
      this.attachSocketHandlers(controlSocket, mediaSocket, generation)
      await this.startDecoder(generation)
      this.sendControlRequest('heartbeat', { channel: 0 })
      this.sendRealplayRequest()
      this.heartbeatTimer = setInterval(() => {
        if (this.running && generation === this.connectionGeneration) {
          this.sendControlRequest('heartbeat', { channel: 0 })
        }
      }, HEARTBEAT_INTERVAL_MS)
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

  private attachSocketHandlers(control: Socket, media: Socket, generation: number): void {
    control.on('data', chunk => {
      if (this.running && generation === this.connectionGeneration) {
        this.consumeXmipChunk('control', Buffer.from(chunk), generation)
      }
    })
    media.on('data', chunk => {
      if (this.running && generation === this.connectionGeneration) {
        this.consumeXmipChunk('media', Buffer.from(chunk), generation)
      }
    })
    for (const [name, socket] of [['control', control], ['media', media]] as const) {
      socket.on('error', error => this.handleStreamFailure(
        `Camera ${name} connection: ${error.message}`, generation))
      socket.on('close', () => this.handleStreamFailure(
        `Camera ${name} connection closed`, generation))
    }
  }

  private startDecoder(generation: number): Promise<void> {
    const decoder = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'warning', '-flags', 'low_delay',
      '-analyzeduration', '0', '-probesize', '32768',
      '-f', 'hevc', '-framerate', '25', '-i', 'pipe:0', '-an',
      '-c:v', 'mjpeg', '-q:v', '4', '-f', 'image2pipe', 'pipe:1'
    ], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.decoder = decoder
    decoder.stdout.on('data', chunk => {
      if (this.running && generation === this.connectionGeneration) {
        this.consumeJpegChunk(Buffer.from(chunk), generation)
      }
    })
    decoder.stderr.on('data', chunk => {
      this.decoderError = `${this.decoderError}${String(chunk)}`.slice(-2_000)
    })
    decoder.stdin.on('error', error => {
      this.handleStreamFailure(`Camera decoder input: ${error.message}`, generation)
    })
    decoder.on('exit', (code, signal) => {
      if (!this.running || generation !== this.connectionGeneration) return
      const detail = this.decoderError.trim().split('\n').at(-1)
      this.handleStreamFailure(
        `Camera decoder exited (${signal ?? code ?? 'unknown'})${detail ? `: ${detail}` : ''}`,
        generation)
    })
    return new Promise((resolve, reject) => {
      decoder.once('spawn', resolve)
      decoder.once('error', error => reject(new Error(`Could not start ffmpeg: ${error.message}`)))
    })
  }

  private sendRealplayRequest(): void {
    const resolution = WIFI_CAMERA_RESOLUTIONS.find(item => item.value === this.options.frameSize) ??
      WIFI_CAMERA_RESOLUTIONS.find(item => item.value === 8)!
    this.sendControlRequest('realplay', {
      channel: 0, stream: 0, HOR_RES: resolution.width, VER_RES: resolution.height, id: 1
    })
  }

  private sendControlRequest(op: string, param: Record<string, unknown>): void {
    if (!this.controlSocket || this.controlSocket.destroyed) return
    const payload = Buffer.from(JSON.stringify({ version: '1.0', type: 'request', op, param }))
    const frame = Buffer.allocUnsafe(XMIP_HEADER_SIZE + payload.length)
    XMIP_MAGIC.copy(frame)
    frame[4] = 0
    frame.writeUInt32LE(payload.length, 5)
    payload.copy(frame, XMIP_HEADER_SIZE)
    this.controlSocket.write(frame)
  }

  private consumeXmipChunk(kind: 'control' | 'media', chunk: Buffer, generation: number): void {
    let buffer = Buffer.concat([kind === 'control' ? this.controlBuffer : this.mediaBuffer, chunk])
    while (buffer.length >= XMIP_HEADER_SIZE) {
      if (!buffer.subarray(0, 4).equals(XMIP_MAGIC)) {
        const next = buffer.indexOf(XMIP_MAGIC, 1)
        if (next < 0) {
          buffer = buffer.subarray(Math.max(0, buffer.length - 3))
          break
        }
        buffer = buffer.subarray(next)
        continue
      }
      const type = buffer[4]
      const payloadLength = buffer.readUInt32LE(5)
      if (payloadLength > MAX_PAYLOAD_SIZE) {
        this.handleStreamFailure('Camera sent an oversized XMIP frame', generation)
        return
      }
      const frameLength = XMIP_HEADER_SIZE + payloadLength
      if (buffer.length < frameLength) break
      const payload = buffer.subarray(XMIP_HEADER_SIZE, frameLength)
      buffer = buffer.subarray(frameLength)
      if (kind === 'control' && type === 0) this.consumeControlPayload(payload)
      if (kind === 'media' && type === 1) this.consumeMediaPayload(payload)
    }
    if (kind === 'control') this.controlBuffer = buffer
    else this.mediaBuffer = buffer
  }

  private consumeControlPayload(payload: Buffer): void {
    try {
      const message = JSON.parse(payload.toString('utf8')) as {
        type?: string
        op?: string
        param?: { width?: number; height?: number; fps?: number; video_codec?: string }
      }
      if (message.type !== 'response' || message.op !== 'realplay') return
      if (message.param?.video_codec && message.param.video_codec.toLowerCase() !== 'h265') {
        throw new Error(`Unsupported camera codec ${message.param.video_codec}`)
      }
      const width = message.param?.width ?? 640
      const height = message.param?.height ?? 480
      const fps = message.param?.fps ?? 25
      this.sendStatus('connecting', `E-Eye negotiated ${width}×${height} H.265 at ${fps} FPS…`)
    } catch (error) {
      console.warn('[WifiCamera] Ignoring invalid XMIP control response', error)
    }
  }

  private consumeMediaPayload(payload: Buffer): void {
    let offset = 0
    while (offset + 4 <= payload.length) {
      if (payload[offset] !== 0 || payload[offset + 1] !== 0 || payload[offset + 2] !== 1) return
      const packetType = payload[offset + 3]
      const headerSize = packetType === 0xfd ? 20 : 14
      const sizeOffset = packetType === 0xfd ? 16 : packetType === 0xfc ? 10 : 12
      if (offset + headerSize > payload.length) return
      const dataLength = payload.readUInt16LE(offset + sizeOffset)
      const packetEnd = offset + headerSize + dataLength
      if (packetEnd > payload.length) return
      if (packetType === 0xfc || packetType === 0xfd) {
        const sequence = payload[offset + (packetType === 0xfd ? 5 : 4)]
        this.consumeVideoPacket(
          payload.subarray(offset + headerSize, packetEnd), sequence, packetType === 0xfd)
      }
      offset = packetEnd
    }
  }

  private consumeVideoPacket(accessUnit: Buffer, sequence: number, isKeyframe: boolean): void {
    if (this.expectedSequence != null && sequence !== this.expectedSequence && !isKeyframe) {
      this.awaitingKeyframe = true
      this.sendControlRequest('forceIFrame', { channel: 0, stream: 0 })
    }
    this.expectedSequence = (sequence + 1) & 0xff
    if (isKeyframe) this.awaitingKeyframe = false
    if (this.awaitingKeyframe || this.decoderBackpressured || accessUnit.length === 0) return
    if (!this.decoder || this.decoder.stdin.destroyed) return
    this.reportBytes += accessUnit.length
    if (!this.decoder.stdin.write(accessUnit)) {
      this.decoderBackpressured = true
      this.awaitingKeyframe = true
      this.decoder.stdin.once('drain', () => {
        this.decoderBackpressured = false
        this.sendControlRequest('forceIFrame', { channel: 0, stream: 0 })
      })
    }
  }

  private consumeJpegChunk(chunk: Buffer, generation: number): void {
    this.jpegBuffer = Buffer.concat([this.jpegBuffer, chunk])
    while (this.jpegBuffer.length > 0) {
      const start = this.jpegBuffer.indexOf(JPEG_START)
      if (start < 0) {
        this.jpegBuffer = this.jpegBuffer.at(-1) === 0xff
          ? this.jpegBuffer.subarray(-1) : Buffer.alloc(0)
        return
      }
      if (start > 0) this.jpegBuffer = this.jpegBuffer.subarray(start)
      const end = this.jpegBuffer.indexOf(JPEG_END, 2)
      if (end < 0) {
        if (this.jpegBuffer.length > MAX_PAYLOAD_SIZE) {
          this.handleStreamFailure('Decoded camera JPEG exceeded the maximum frame size', generation)
        }
        return
      }
      const frameEnd = end + JPEG_END.length
      const frame = Buffer.from(this.jpegBuffer.subarray(0, frameEnd))
      this.jpegBuffer = this.jpegBuffer.subarray(frameEnd)
      this.queueFrame(frame)
      if (!this.receivedFrame) {
        this.receivedFrame = true
        this.sendStatus('streaming', `E-Eye camera streaming at ${frameSizeLabel(this.options.frameSize)}`)
      }
    }
  }

  private closeTransport(): void {
    this.connectionGeneration += 1
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
    this.controlSocket?.destroy()
    this.mediaSocket?.destroy()
    this.controlSocket = null
    this.mediaSocket = null
    this.decoder?.stdin.destroy()
    this.decoder?.kill('SIGTERM')
    this.decoder = null
    this.controlBuffer = Buffer.alloc(0)
    this.mediaBuffer = Buffer.alloc(0)
    this.jpegBuffer = Buffer.alloc(0)
    this.decoderError = ''
    this.decoderBackpressured = false
    this.awaitingKeyframe = true
    this.expectedSequence = null
    this.rendererBusy = false
    this.pendingFrame = null
    this.receivedFrame = false
  }

  private handleStreamFailure(message: string, generation: number): void {
    if (!this.running || generation !== this.connectionGeneration) return
    this.closeTransport()
    this.scheduleReconnect(message)
  }

  private scheduleReconnect(reason: string): void {
    if (!this.running || this.reconnectTimer) return
    this.reconnectCount += 1
    this.sendStatus('connecting', `${reason}. Reconnecting…`)
    this.sendDiagnostics()
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.running) return
      this.starting = this.connectStream(true).finally(() => { this.starting = null })
    }, RECONNECT_DELAY_MS)
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private queueFrame(frame: Buffer): void {
    this.lastFrameAt = Date.now()
    this.lastFrameSize = frame.length
    this.receivedFrames += 1
    this.reportFrames += 1
    if (this.rendererBusy) {
      if (this.pendingFrame) this.replacedFrames += 1
      this.pendingFrame = frame
      return
    }
    this.deliverFrame(frame)
  }

  private deliverFrame(frame: Buffer): void {
    this.rendererBusy = this.events.send('wifi-camera-frame', frame)
  }

  private sendStatus(state: CameraState, message: string): void {
    this.state = state
    this.events.send('wifi-camera-status', { state, message })
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
    this.diagnosticsTimer = setInterval(() => { void this.updateDiagnostics() }, DIAGNOSTICS_INTERVAL_MS)
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
    if (this.running && !this.reconnectTimer && frameReference > 0 && now - frameReference > STALE_STREAM_MS) {
      this.handleStreamFailure('Camera stream stalled', this.connectionGeneration)
    }
    if (!this.diagnosticsBusy) {
      this.diagnosticsBusy = true
      try { this.wifiMetrics = await readWifiLink(this.options.host) }
      finally { this.diagnosticsBusy = false }
    }
    this.sendDiagnostics()
  }

  private sendDiagnostics(): void {
    this.events.send('wifi-camera-diagnostics', {
      state: this.state,
      fps: this.currentFps,
      bitrateKbps: this.currentBitrateKbps,
      frameSizeKb: this.lastFrameSize / 1024,
      lastFrameAgeMs: this.lastFrameAt ? Date.now() - this.lastFrameAt : null,
      receivedFrames: this.receivedFrames,
      replacedFrames: this.replacedFrames,
      reconnectCount: this.reconnectCount,
      ...this.wifiMetrics
    } satisfies WifiCameraDiagnostics)
  }
}

function openSocket(host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = new Socket()
    const onError = (error: Error): void => {
      socket.destroy()
      reject(new Error(`Camera port ${port}: ${error.message}`))
    }
    socket.setTimeout(8_000, () => socket.destroy(new Error('connection timed out')))
    socket.once('error', onError)
    socket.connect(port, host, () => {
      socket.setTimeout(0)
      socket.off('error', onError)
      resolve(socket)
    })
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
      const frequencyMhz = parseOptionalNumber(link.match(/^\s*freq:\s*(\d+)/m)?.[1])
      try {
        metrics.noiseDbm = parseSurveyNoise(
          await runCommand('iw', ['dev', interfaceName, 'survey', 'dump']), frequencyMhz)
      } catch { /* Not exposed by every wireless driver. */ }
    } catch { /* Keep the route interface when link details are unavailable. */ }
    try {
      metrics.powerSave = /Power save:\s*on/i.test(
        await runCommand('iw', ['dev', interfaceName, 'get', 'power_save']))
    } catch { /* Not supported by every wireless driver. */ }
    return metrics
  } catch { return {} }
}

function runCommand(command: string, args: string[]): Promise<string> {
  return execFileAsync(command, args, {
    encoding: 'utf8', timeout: 2_000, maxBuffer: 64 * 1024,
    env: { ...process.env, LC_ALL: 'C' }
  }).then(result => String(result.stdout))
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value == null) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function parseSurveyNoise(survey: string, frequencyMhz: number | undefined): number | undefined {
  const sections = survey.split(/(?=^\s*frequency:)/m)
  const active = sections.find(section => frequencyMhz != null
    ? parseOptionalNumber(section.match(/^\s*frequency:\s*(\d+)/m)?.[1]) === frequencyMhz
    : /\[in use\]/i.test(section))
  return parseOptionalNumber(active?.match(/^\s*noise:\s*(-?[\d.]+)\s*dBm/m)?.[1])
}

function normalizeOptions(options: Partial<WifiCameraOptions> | null | undefined): WifiCameraOptions {
  return {
    host: normalizeHost(options?.host),
    frameSize: normalizeFrameSize(options?.frameSize),
    // Retained for backwards-compatible saved config; E-Eye sends H.265 and
    // does not expose the old ESP32 JPEG-quality or mirror controls.
    jpegQuality: normalizeJpegQuality(options?.jpegQuality),
    horizontalFlip: options?.horizontalFlip === true
  }
}

function normalizeHost(value: unknown): string {
  const candidate = String(value ?? '').trim()
  if (!candidate) return DEFAULT_OPTIONS.host
  try {
    return new URL(candidate.includes('://') ? candidate : `http://${candidate}`).hostname ||
      DEFAULT_OPTIONS.host
  } catch { return DEFAULT_OPTIONS.host }
}

function normalizeFrameSize(value: unknown): WifiCameraFrameSize {
  const frameSize = Number(value)
  return SUPPORTED_FRAME_SIZES.has(frameSize)
    ? frameSize as WifiCameraFrameSize : DEFAULT_OPTIONS.frameSize
}

function normalizeJpegQuality(value: unknown): number {
  const quality = Math.round(Number(value))
  return Number.isFinite(quality) ? Math.min(63, Math.max(4, quality)) : DEFAULT_OPTIONS.jpegQuality
}

function frameSizeLabel(frameSize: WifiCameraFrameSize): string {
  return WIFI_CAMERA_RESOLUTIONS.find(item => item.value === frameSize)?.label ?? 'VGA 640×480'
}
