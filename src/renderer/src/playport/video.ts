import {
  annexBToAvcc,
  avcCodecString,
  VideoCodec,
  type VideoConfigMessage,
  type VideoFrameMessage
} from './protocol'

/** Low-latency WebCodecs renderer for one PlayPort CarPlay screen stream. */
export class PlayPortVideo {
  private decoder: VideoDecoder | null = null
  private usesDescription = false
  private timestampUs = 0
  private configured = false
  private decoderConfig: VideoDecoderConfig | null = null
  private waitingForKeyframe = true
  private lastKeyframeRequest = -Infinity

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onFrame: () => void,
    private readonly onError: (message: string) => void,
    private readonly requestKeyframe: () => void,
    private readonly onSourceFrame?: (frame: VideoFrame) => void
  ) {}

  configure(message: VideoConfigMessage): void {
    this.close()
    if (typeof VideoDecoder === 'undefined') {
      this.onError('This Chromium build does not expose WebCodecs VideoDecoder.')
      return
    }
    if (message.codec !== VideoCodec.H264) {
      this.onError('PlayPort must use H.264 for this display.')
      return
    }

    const descriptionPresent = message.codecData.length > 4
    const decoder = new VideoDecoder({
      output: (frame) => this.draw(frame),
      error: (error) => {
        this.onError(error.message)
        this.requestKeyframe()
      }
    })
    try {
      const configuration: VideoDecoderConfig = {
        codec: avcCodecString(message.codecData),
        codedWidth: message.width,
        codedHeight: message.height,
        hardwareAcceleration: 'prefer-hardware',
        optimizeForLatency: true,
        ...(descriptionPresent ? { description: message.codecData } : {})
      }
      decoder.configure(configuration)
      this.decoderConfig = configuration
      this.decoder = decoder
      this.usesDescription = descriptionPresent
      this.timestampUs = 0
      this.configured = true
      this.canvas.width = message.width
      this.canvas.height = message.height
      this.onError('')
    } catch (error) {
      decoder.close()
      this.onError(error instanceof Error ? error.message : String(error))
    }
  }

  push(message: VideoFrameMessage): void {
    if (!this.decoder || !this.configured || this.decoder.state !== 'configured') return
    // A slow Pi decoder must not retain an ever-growing history of frames.
    // Reset the H.264 reference chain and resume only at a fresh keyframe.
    if (this.decoder.decodeQueueSize >= 6 && this.decoderConfig) {
      try {
        this.decoder.reset()
        this.decoder.configure(this.decoderConfig)
        this.waitingForKeyframe = true
      } catch (error) {
        this.onError(error instanceof Error ? error.message : String(error))
        return
      }
    }
    if (this.waitingForKeyframe && !message.keyframe) {
      const now = performance.now()
      if (now - this.lastKeyframeRequest > 1_000) {
        this.lastKeyframeRequest = now
        this.requestKeyframe()
      }
      return
    }
    if (message.keyframe) this.waitingForKeyframe = false
    const data = this.usesDescription ? annexBToAvcc(message.data) : message.data
    if (!data.length) return
    this.timestampUs += 16_667
    try {
      this.decoder.decode(new EncodedVideoChunk({
        type: message.keyframe ? 'key' : 'delta',
        timestamp: this.timestampUs,
        data
      }))
    } catch (error) {
      this.onError(error instanceof Error ? error.message : String(error))
      this.requestKeyframe()
    }
  }

  close(): void {
    this.configured = false
    this.decoderConfig = null
    this.waitingForKeyframe = true
    this.lastKeyframeRequest = -Infinity
    if (this.decoder) {
      try { this.decoder.close() } catch {}
    }
    this.decoder = null
  }

  restartAtKeyframe(): void {
    try {
      if (this.decoder?.state === 'configured' && this.decoderConfig) {
        this.decoder.reset()
        this.decoder.configure(this.decoderConfig)
      }
    } catch (error) {
      this.onError(error instanceof Error ? error.message : String(error))
    }
    this.waitingForKeyframe = true
    this.requestKeyframe()
  }

  private draw(frame: VideoFrame): void {
    try {
      // Resample the full frame at the canvas's displayed pixel size. Keeping
      // a 512px backing store leaves all enlargement to the CSS compositor.
      // clientWidth/Height exclude the dashboard's HDMI aspect correction;
      // that correction must remain a separate, final presentation transform.
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
      const width = Math.max(1, Math.round((this.canvas.clientWidth || frame.displayWidth) * pixelRatio))
      const height = Math.max(1, Math.round((this.canvas.clientHeight || frame.displayHeight) * pixelRatio))
      if (this.canvas.width !== width) this.canvas.width = width
      if (this.canvas.height !== height) this.canvas.height = height
      const context = this.canvas.getContext('2d', { alpha: false, desynchronized: true })
      if (context) {
        // Resizing a canvas resets these flags, so apply them after resizing.
        context.imageSmoothingEnabled = true
        context.imageSmoothingQuality = 'high'
        context.drawImage(frame, 0, 0, width, height)
      }
      this.onFrame()
      this.onSourceFrame?.(frame)
    } finally {
      frame.close()
    }
  }
}
