import {
  getDecoderConfig,
  getNaluFromStream,
  isKeyFrame,
  NaluTypes
} from './worker/render/lib/utils'

type RetryFrame = () => void

/**
 * Chromium-on-Cage fallback for platforms where VideoDecoder is not exposed
 * inside a dedicated worker. Electron keeps using the existing offscreen
 * worker; the browser runtime decodes on the page and draws directly to a 2D
 * canvas. At 480x480 this path is small, predictable, and avoids an extra
 * ImageBitmap/WebGL upload for every frame.
 */
export class BrowserVideoRenderer {
  private readonly context: CanvasRenderingContext2D | null
  private decoder: VideoDecoder | null = null
  private configured = false
  private awaitingKeyframe = true
  private lastSps: Uint8Array | null = null
  private acceleration: HardwareAcceleration = 'prefer-hardware'
  private decodeErrors = 0
  private renderedFirstFrame = false
  private processing = Promise.resolve()
  private closed = false

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly retryFrame: RetryFrame
  ) {
    this.context = canvas.getContext('2d', { alpha: false, desynchronized: true })
    this.report('browser-renderer-capabilities', {
      secureContext: window.isSecureContext,
      crossOriginIsolated: window.crossOriginIsolated,
      videoDecoder: typeof VideoDecoder,
      canvas2d: Boolean(this.context),
      userAgent: navigator.userAgent
    })

    if (typeof VideoDecoder === 'undefined' || !this.context) {
      this.report('browser-renderer-unavailable', {
        videoDecoder: typeof VideoDecoder,
        canvas2d: Boolean(this.context)
      })
      return
    }

    this.decoder = this.createDecoder()
  }

  push(packet: any): void {
    if (this.closed || !this.decoder) return
    this.processing = this.processing
      .then(() => this.processPacket(packet))
      .catch((error) => {
        this.report('browser-renderer-packet-error', {
          message: error instanceof Error ? error.message : String(error)
        })
      })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      if (this.decoder?.state !== 'closed') this.decoder?.close()
    } catch {}
    this.decoder = null
  }

  private createDecoder(): VideoDecoder {
    return new VideoDecoder({
      output: (frame) => this.draw(frame),
      error: (error) => this.handleDecoderError(error)
    })
  }

  private async processPacket(packet: any): Promise<void> {
    const decoder = this.decoder
    if (!decoder || decoder.state === 'closed') return

    const bytes = toUint8Array(packet?.chunk)
    if (bytes.byteLength <= 20) return
    const videoData = bytes.subarray(20)
    const sps = getNaluFromStream(videoData, NaluTypes.SPS)
    const keyframe = isKeyFrame(videoData)

    if (sps && !this.configured) {
      this.lastSps = sps.rawNalu
      this.report('browser-decoder-sps', {
        length: sps.rawNalu.length,
        packetBytes: videoData.byteLength
      })
    }

    if (this.awaitingKeyframe && !keyframe) return

    if (!this.configured) {
      if (!keyframe || !this.lastSps) return
      const config = getDecoderConfig(this.lastSps)
      if (!config) {
        this.report('browser-decoder-config-missing', {})
        return
      }
      if (!(await this.configure(config))) return
    }

    try {
      decoder.decode(
        new EncodedVideoChunk({
          type: keyframe ? 'key' : 'delta',
          timestamp: Math.round(performance.now() * 1000),
          data: videoData
        })
      )
      if (keyframe) this.awaitingKeyframe = false
    } catch (error) {
      this.handleDecoderError(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private async configure(config: VideoDecoderConfig): Promise<boolean> {
    const preferences: HardwareAcceleration[] =
      this.acceleration === 'prefer-hardware'
        ? ['prefer-hardware', 'no-preference', 'prefer-software']
        : ['prefer-software', 'no-preference']

    for (const acceleration of preferences) {
      const candidate: VideoDecoderConfig = {
        ...config,
        hardwareAcceleration: acceleration,
        optimizeForLatency: true
      }
      try {
        const support = await VideoDecoder.isConfigSupported(candidate)
        this.report('browser-decoder-config-support', {
          codec: candidate.codec,
          codedWidth: candidate.codedWidth,
          codedHeight: candidate.codedHeight,
          acceleration,
          supported: support.supported
        })
        if (!support.supported || !this.decoder) continue
        this.decoder.configure(support.config || candidate)
        this.acceleration = acceleration
        this.configured = true
        return true
      } catch (error) {
        this.report('browser-decoder-config-error', {
          acceleration,
          message: error instanceof Error ? error.message : String(error)
        })
      }
    }
    return false
  }

  private handleDecoderError(error: Error): void {
    this.report('browser-decoder-error', {
      message: error.message,
      acceleration: this.acceleration,
      state: this.decoder?.state
    })
    this.decodeErrors++
    this.configured = false
    this.awaitingKeyframe = true
    if (this.decodeErrors > 3 || this.closed) return

    if (this.acceleration === 'prefer-hardware') this.acceleration = 'prefer-software'
    try {
      if (this.decoder?.state !== 'closed') this.decoder?.close()
    } catch {}
    this.decoder = this.createDecoder()
    window.setTimeout(this.retryFrame, 100)
  }

  private draw(frame: VideoFrame): void {
    try {
      if (this.canvas.width !== frame.displayWidth) this.canvas.width = frame.displayWidth
      if (this.canvas.height !== frame.displayHeight) this.canvas.height = frame.displayHeight
      this.context?.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height)
      if (!this.renderedFirstFrame) {
        this.renderedFirstFrame = true
        this.report('browser-render-first-frame', {
          width: frame.displayWidth,
          height: frame.displayHeight,
          acceleration: this.acceleration
        })
      }
    } catch (error) {
      this.report('browser-render-error', {
        message: error instanceof Error ? error.message : String(error)
      })
    } finally {
      frame.close()
    }
  }

  private report(event: string, detail: unknown): void {
    void fetch('/diagnostics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, detail })
    }).catch(() => undefined)
  }
}

function toUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  return new Uint8Array()
}
