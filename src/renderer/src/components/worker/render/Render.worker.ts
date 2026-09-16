import { getDecoderConfig, getNaluFromStream, isKeyFrame, NaluTypes } from './lib/utils'
import { InitEvent, WorkerEvent } from './RenderEvents'
import { WebGL2Renderer } from './WebGL2Renderer'
import { WebGLRenderer } from './WebGLRenderer'
import { WebGPURenderer } from './WebGPURenderer'

export interface FrameRenderer {
  draw(data: VideoFrame): void | Promise<void>
}

const scope = self as unknown as Worker

export class RendererWorker {
  private readonly vendorHeaderSize = 20
  private renderer: FrameRenderer | null = null
  private videoPort: MessagePort | null = null
  private pendingFrame: VideoFrame | null = null
  private startTime: number | null = null
  private frameCount = 0
  private fps = 0
  private decoder: VideoDecoder
  private isConfigured = false
  private lastSPS: Uint8Array | null = null
  private useHardware = false
  private awaitingValidKeyframe = true
  private hardwareAccelerationTested = false
  private selectedRenderer: string | null = null
  private renderScheduled = false
  private lastRenderTime: number = 0
  private frameInterval: number = 1000 / 60 // 60Hz
  private decoderAcceleration: HardwareAcceleration = 'prefer-hardware'
  private decodedFirstFrame = false
  private renderedFirstFrame = false

  constructor() {
    this.decoder = this.createDecoder()
  }

  private createDecoder = () =>
    new VideoDecoder({
      output: this.onVideoDecoderOutput,
      error: this.onVideoDecoderOutputError
    })

  private onVideoDecoderOutput = (frame: VideoFrame) => {
    if (!this.decodedFirstFrame) {
      this.decodedFirstFrame = true
      reportBrowserDiagnostic('decoder-first-frame', {
        width: frame.displayWidth,
        height: frame.displayHeight,
        acceleration: this.decoderAcceleration
      })
    }
    if (this.startTime == null) {
      this.startTime = performance.now()
    } else {
      const elapsed = (performance.now() - this.startTime) / 1000
      this.fps = ++this.frameCount / elapsed
    }

    this.renderFrame(frame)
  }

  private renderFrame = (frame: VideoFrame) => {
    this.pendingFrame?.close()
    this.pendingFrame = frame

    if (!this.renderScheduled) {
      this.renderScheduled = true
      requestAnimationFrame(this.renderAnimationFrame)
    }
  }

  private renderAnimationFrame = () => {
    this.renderScheduled = false

    const now = performance.now()
    if (now - this.lastRenderTime < this.frameInterval * 0.75) {
      requestAnimationFrame(this.renderAnimationFrame)
      return
    }

    if (this.pendingFrame) {
      const frame = this.pendingFrame
      this.pendingFrame = null
      this.lastRenderTime = now
      if (!this.renderer) {
        frame.close()
        reportBrowserDiagnostic('render-frame-without-renderer', {})
        return
      }
      Promise.resolve(this.renderer.draw(frame))
        .then(() => {
          if (!this.renderedFirstFrame) {
            this.renderedFirstFrame = true
            reportBrowserDiagnostic('render-first-frame', {
              renderer: this.selectedRenderer
            })
          }
        })
        .catch((error) => {
          try {
            frame.close()
          } catch {}
          reportBrowserDiagnostic('render-error', {
            renderer: this.selectedRenderer,
            message: error instanceof Error ? error.message : String(error)
          })
        })
    }
  }

  private onVideoDecoderOutputError = (err: Error) => {
    console.error(`[RENDER.WORKER] Decoder error`, err)
    reportBrowserDiagnostic('decoder-error', {
      message: err.message,
      acceleration: this.decoderAcceleration,
      state: this.decoder.state
    })
    this.isConfigured = false
    this.awaitingValidKeyframe = true
    this.decodedFirstFrame = false
    if (this.decoderAcceleration === 'prefer-hardware') {
      this.decoderAcceleration = 'prefer-software'
    }
    try {
      if (this.decoder.state !== 'closed') this.decoder.close()
    } catch {}
    this.decoder = this.createDecoder()
    scope.postMessage({ type: 'decoder-retry' })
  }

  init = async (event: InitEvent & { platform?: string }) => {
    this.useHardware = event.useHardware

    this.videoPort = event.videoPort
    this.videoPort.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
      this.processRaw(ev.data)
    }
    this.videoPort.start()

    self.postMessage({ type: 'render-ready' })
    reportBrowserDiagnostic('render-worker-ready', {
      platform: navigator.platform,
      webCodecs: typeof VideoDecoder !== 'undefined'
    })
    console.debug('[RENDER.WORKER] render-ready')

    if (event.reportFps) {
      setInterval(() => {
        if (this.decoder.state === 'configured') {
          console.debug(`[RENDER.WORKER] FPS: ${this.fps.toFixed(2)}`)
        }
      }, 5000)
    }

    await this.evaluateRendererCapabilities()

    if (this.selectedRenderer === 'webgl2') {
      this.renderer = new WebGL2Renderer(event.canvas)
    } else if (this.selectedRenderer === 'webgl') {
      this.renderer = new WebGLRenderer(event.canvas)
    } else if (this.selectedRenderer === 'webgpu') {
      this.renderer = new WebGPURenderer(event.canvas)
    }

    if (!this.renderer) {
      console.warn('[RENDER.WORKER] No valid renderer selected, cannot proceed.')
    }
  }

  private async evaluateRendererCapabilities() {
    if (this.hardwareAccelerationTested) return

    console.debug('[RENDER.WORKER] Starting hardware acceleration tests...')

    const platform = navigator.platform.toLowerCase()
    const isMac = platform.startsWith('mac')

    const rendererPriority = isMac ? ['webgpu', 'webgl2', 'webgl'] : ['webgl2', 'webgl', 'webgpu']

    const results: Record<string, { hw: boolean; sw: boolean; available: boolean }> = {}
    for (const r of rendererPriority) {
      results[r] = await this.isRendererSupported(r)
      console.debug(
        `[RENDER.WORKER] ${r.toUpperCase()}: available=${results[r].available}, ` +
          `hw=${results[r].hw}, sw=${results[r].sw}`
      )
    }

    // The Pi must prefer hardware decode. Software H.264 decoding can saturate
    // the CPU, starve the USB/WebSocket path and make AutoKit disconnect.
    const selectOrder: ('hw' | 'sw')[] = this.useHardware ? ['hw', 'sw'] : ['sw', 'hw']

    for (const mode of selectOrder) {
      for (const r of rendererPriority) {
        const caps = results[r]
        if (caps.available && caps[mode]) {
          this.selectedRenderer = r
          this.useHardware = mode === 'hw'
          this.hardwareAccelerationTested = true
          console.debug(
            `[RENDER.WORKER] Selected renderer: ${r} (` +
              `${mode === 'hw' ? 'hardware' : 'software'})`
          )
          this.decoderAcceleration = mode === 'hw' ? 'prefer-hardware' : 'prefer-software'
          reportBrowserDiagnostic('renderer-selected', {
            renderer: r,
            acceleration: this.decoderAcceleration,
            capabilities: results
          })
          return
        }
      }
    }

    console.warn('[RENDER.WORKER] No suitable renderer found')
    reportBrowserDiagnostic('renderer-unavailable', { capabilities: results })
  }

  private async isRendererSupported(
    renderer: string
  ): Promise<{ hw: boolean; sw: boolean; available: boolean }> {
    const canvas = new OffscreenCanvas(1, 1)
    let context: WebGLRenderingContext | WebGL2RenderingContext | GPUCanvasContext | null = null

    if (renderer === 'webgl2') {
      context = canvas.getContext('webgl2')
    } else if (renderer === 'webgl') {
      context = canvas.getContext('webgl')
    } else if (renderer === 'webgpu') {
      try {
        context = canvas.getContext('webgpu')
      } catch (e) {
        context = null
      }
    }

    if (!context) {
      return { hw: false, sw: false, available: false }
    }

    let hwSupported = false
    let swSupported = false

    const hwConfig: VideoDecoderConfig = {
      codec: 'avc1.64002A',
      hardwareAcceleration: 'prefer-hardware'
    }
    try {
      const hwSupportedResult = await VideoDecoder.isConfigSupported(hwConfig)
      hwSupported = !!hwSupportedResult.supported
    } catch (e) {
      console.warn(`[RENDER.WORKER] Error testing ${renderer} hardware:`, e)
    }

    const swConfig: VideoDecoderConfig = {
      codec: 'avc1.64002A',
      hardwareAcceleration: 'prefer-software'
    }
    try {
      const swSupportedResult = await VideoDecoder.isConfigSupported(swConfig)
      swSupported = !!swSupportedResult.supported
    } catch (e) {
      console.warn(`[RENDER.WORKER] Error testing ${renderer} software:`, e)
    }

    context = null

    return { hw: hwSupported, sw: swSupported, available: true }
  }

  private async configureDecoder(config: VideoDecoderConfig) {
    const preferences: HardwareAcceleration[] =
      this.decoderAcceleration === 'prefer-hardware'
        ? ['prefer-hardware', 'no-preference', 'prefer-software']
        : ['prefer-software', 'no-preference']

    for (const acceleration of preferences) {
      const cfg: VideoDecoderConfig = {
        ...structuredClone(config),
        hardwareAcceleration: acceleration,
        optimizeForLatency: true
      }

      try {
        const support = await VideoDecoder.isConfigSupported(cfg)
        reportBrowserDiagnostic('decoder-config-support', {
          codec: cfg.codec,
          codedWidth: cfg.codedWidth,
          codedHeight: cfg.codedHeight,
          acceleration,
          supported: support.supported
        })
        if (!support.supported) continue
        this.decoder.configure(support.config || cfg)
        this.decoderAcceleration = acceleration
        this.isConfigured = true
        return true
      } catch (err) {
        console.warn(`[RENDER.WORKER] Config ${acceleration} error`, err)
        reportBrowserDiagnostic('decoder-config-error', {
          acceleration,
          message: err instanceof Error ? err.message : String(err)
        })
      }
    }
    return false
  }

  private async processRaw(buffer: ArrayBuffer) {
    if (!buffer.byteLength) return

    const data = new Uint8Array(buffer)
    const videoData =
      data.length > this.vendorHeaderSize ? data.subarray(this.vendorHeaderSize) : data

    const sps = getNaluFromStream(videoData, NaluTypes.SPS)
    const key = isKeyFrame(videoData)
    const now = performance.now()

    if (sps && !this.isConfigured) {
      console.debug('[RENDER.WORKER] SPS detected, length:', sps.rawNalu?.length)
      this.lastSPS = sps.rawNalu
      reportBrowserDiagnostic('decoder-sps', {
        length: sps.rawNalu?.length,
        packetBytes: videoData.byteLength
      })
    }

    if (this.awaitingValidKeyframe && !key) {
      console.debug('[RENDER.WORKER] Ignoring delta while awaiting keyframe...')
      return
    }

    if (key && this.lastSPS && !this.isConfigured) {
      console.debug('[RENDER.WORKER] First keyframe detected, attempting decoder config...')
      const config = getDecoderConfig(this.lastSPS)
      if (!config) reportBrowserDiagnostic('decoder-config-missing', {})
      if (config && (await this.configureDecoder(config))) {
        try {
          const chunk = new EncodedVideoChunk({
            type: 'key',
            timestamp: now,
            data: videoData
          })
          this.decoder.decode(chunk)
          console.debug('[RENDER.WORKER] SPS+IDR sent')
          this.awaitingValidKeyframe = false
          return
        } catch (e) {
          console.warn('[RENDER.WORKER] Failed to decode first keyframe', e)
          return
        }
      }
    }

    if (!this.isConfigured || this.awaitingValidKeyframe) return

    const chunk = new EncodedVideoChunk({
      type: key ? 'key' : 'delta',
      timestamp: now,
      data: videoData
    })

    try {
      this.decoder.decode(chunk)
    } catch (e) {
      console.error('[RENDER.WORKER] Error during decoding:', e)
    }
  }
}

function reportBrowserDiagnostic(event: string, detail: unknown): void {
  if (self.location.protocol !== 'http:' && self.location.protocol !== 'https:') return
  void fetch(new URL('/diagnostics', self.location.origin), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, detail })
  }).catch(() => undefined)
}

const worker = new RendererWorker()
scope.addEventListener('message', (event: MessageEvent<WorkerEvent>) => {
  if (event.data.type === 'init') {
    worker.init(event.data as InitEvent & { platform?: string })
  }
})

export {}
