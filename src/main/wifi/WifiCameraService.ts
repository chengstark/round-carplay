import { WebContents } from 'electron'
import dgram from 'node:dgram'
import net from 'node:net'

const DEFAULT_HOST = '192.168.1.1'
const CONTROL_PORT = 3333
const UDP_PORT = 2224
const FRAME_HEADER_SIZE = 20
const JPEG_FRAME_TYPE = 2
const MAX_FRAME_SIZE = 16 * 1024 * 1024
const MAX_ASSEMBLIES = 8

type CameraState = 'connecting' | 'streaming' | 'error' | 'stopped'

interface FrameAssembly {
  frameSize: number
  chunks: Map<number, Buffer>
}

export interface WifiCameraStartResult {
  ok: boolean
  error?: string
}

/**
 * JieLi AC792x/CC31 camera client used by the round-display UI.
 *
 * Control uses the camera's CTP protocol over TCP. Video is fragmented MJPEG
 * delivered to UDP port 2224. Only one JPEG is allowed to be in flight to the
 * renderer; if Chromium is still decoding it, newer completed frames replace
 * the pending frame so latency cannot grow into a backlog.
 */
export class WifiCameraService {
  private renderer: WebContents | null = null
  private control: net.Socket | null = null
  private udp: dgram.Socket | null = null
  private heartbeat: NodeJS.Timeout | null = null
  private controlBuffer = Buffer.alloc(0)
  private assemblies = new Map<number, FrameAssembly>()
  private accessed = false
  private running = false
  private starting: Promise<WifiCameraStartResult> | null = null
  private rendererBusy = false
  private pendingFrame: Buffer | null = null

  attachRenderer(renderer: WebContents): void {
    this.renderer = renderer
  }

  start(): Promise<WifiCameraStartResult> {
    if (this.running && !this.starting) return Promise.resolve({ ok: true })
    if (this.starting) return this.starting

    this.starting = this.startInternal().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async startInternal(): Promise<WifiCameraStartResult> {
    this.running = true
    this.accessed = false
    this.rendererBusy = false
    this.pendingFrame = null
    this.controlBuffer = Buffer.alloc(0)
    this.assemblies.clear()
    this.sendStatus('connecting', 'Connecting to Wi-Fi camera…')

    try {
      await this.bindUdp()
      await this.connectControl()

      this.sendTopic('APP_ACCESS', {
        op: 'PUT',
        param: { type: '0', ver: '20701' }
      })

      // The retail camera normally acknowledges APP_ACCESS immediately, then
      // emits its initial status topics. Waiting briefly keeps OPEN_RT_STREAM
      // from racing that startup burst without making the button feel slow.
      await this.waitForAccess(1000)
      await delay(350)

      if (!this.running) throw new Error('Camera start cancelled')
      this.sendTopic('OPEN_RT_STREAM', {
        op: 'PUT',
        param: { format: '0', w: '1280', h: '720', fps: '25' }
      })

      this.heartbeat = setInterval(() => {
        if (this.running) this.sendTopic('CTP_KEEP_ALIVE', { op: 'PUT' })
      }, 5000)

      this.sendStatus('streaming', 'Waiting for camera video…')
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.cleanup()
      this.sendStatus('error', message)
      return { ok: false, error: message }
    }
  }

  stop(): void {
    if (this.control?.writable) {
      this.sendTopic('CLOSE_RT_STREAM', {
        op: 'PUT',
        param: { status: '1' }
      })
    }
    this.cleanup()
    this.sendStatus('stopped', 'Wi-Fi camera stopped')
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
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null

    this.control?.destroy()
    this.control = null

    try {
      this.udp?.close()
    } catch {
      // Socket may already be closed after a startup error.
    }
    this.udp = null

    this.controlBuffer = Buffer.alloc(0)
    this.assemblies.clear()
    this.rendererBusy = false
    this.pendingFrame = null
  }

  private async bindUdp(): Promise<void> {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    this.udp = socket

    socket.on('message', (datagram) => this.consumeDatagram(datagram))
    socket.on('error', (error) => {
      if (this.running) this.sendStatus('error', `UDP: ${error.message}`)
    })

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        socket.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        socket.off('error', onError)
        resolve()
      }
      socket.once('error', onError)
      socket.once('listening', onListening)
      socket.bind(UDP_PORT)
    })

    try {
      socket.setRecvBufferSize(8 * 1024 * 1024)
    } catch (error) {
      console.warn('[WifiCamera] Could not enlarge UDP receive buffer', error)
    }
    console.log(`[WifiCamera] Listening for MJPEG on UDP :${UDP_PORT}`)
  }

  private async connectControl(): Promise<void> {
    const socket = new net.Socket()
    this.control = socket

    socket.setNoDelay(true)
    socket.on('data', (data) => this.consumeControl(data))
    socket.on('error', (error) => {
      if (this.running && !this.starting) {
        this.sendStatus('error', `Control: ${error.message}`)
      }
    })
    socket.on('close', () => {
      if (this.running && !this.starting) {
        this.sendStatus('error', 'Camera control connection closed')
      }
    })

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        socket.off('connect', onConnect)
        reject(error)
      }
      const onConnect = () => {
        socket.off('error', onError)
        resolve()
      }
      socket.once('error', onError)
      socket.once('connect', onConnect)
      socket.connect(CONTROL_PORT, DEFAULT_HOST)
    })

    console.log(`[WifiCamera] Control connected to ${DEFAULT_HOST}:${CONTROL_PORT}`)
  }

  private waitForAccess(timeoutMs: number): Promise<void> {
    if (this.accessed) return Promise.resolve()

    return new Promise((resolve) => {
      const started = Date.now()
      const timer = setInterval(() => {
        if (this.accessed || !this.running || Date.now() - started >= timeoutMs) {
          clearInterval(timer)
          resolve()
        }
      }, 25)
    })
  }

  private sendTopic(topic: string, payload: Record<string, unknown>): void {
    if (!this.control?.writable) return

    const topicBytes = Buffer.from(topic, 'utf8')
    const jsonBytes = Buffer.from(JSON.stringify(payload), 'utf8')
    const header = Buffer.alloc(10)
    header.write('CTP:', 0, 'ascii')
    header.writeUInt16LE(topicBytes.length, 4)
    header.writeUInt32LE(jsonBytes.length, 6)
    this.control.write(
      Buffer.concat([header.subarray(0, 6), topicBytes, header.subarray(6), jsonBytes])
    )
  }

  private consumeControl(data: Buffer): void {
    this.controlBuffer = Buffer.concat([this.controlBuffer, data])

    while (this.controlBuffer.length >= 10) {
      const signature = this.controlBuffer.indexOf('CTP:')
      if (signature < 0) {
        this.controlBuffer = this.controlBuffer.subarray(Math.max(0, this.controlBuffer.length - 3))
        return
      }
      if (signature > 0) this.controlBuffer = this.controlBuffer.subarray(signature)
      if (this.controlBuffer.length < 10) return

      const topicLength = this.controlBuffer.readUInt16LE(4)
      if (topicLength > 4096) {
        this.controlBuffer = this.controlBuffer.subarray(4)
        continue
      }

      const payloadLengthOffset = 6 + topicLength
      if (this.controlBuffer.length < payloadLengthOffset + 4) return
      const payloadLength = this.controlBuffer.readUInt32LE(payloadLengthOffset)
      if (payloadLength > 5 * 1024 * 1024) {
        this.controlBuffer = this.controlBuffer.subarray(4)
        continue
      }

      const packetLength = payloadLengthOffset + 4 + payloadLength
      if (this.controlBuffer.length < packetLength) return

      const topic = this.controlBuffer.subarray(6, payloadLengthOffset).toString('utf8')
      this.controlBuffer = this.controlBuffer.subarray(packetLength)

      if (topic === 'APP_ACCESS') this.accessed = true
      if (topic === 'OPEN_RT_STREAM') {
        console.log('[WifiCamera] Camera acknowledged OPEN_RT_STREAM')
      }
    }
  }

  private consumeDatagram(datagram: Buffer): void {
    let cursor = 0
    while (datagram.length - cursor >= FRAME_HEADER_SIZE) {
      const header = datagram.subarray(cursor, cursor + FRAME_HEADER_SIZE)
      const type = header[0] & 0x7f
      const chunkSize = header.readUInt16LE(2)
      const sequence = header.readUInt32LE(4)
      const frameSize = header.readUInt32LE(8)
      const offset = header.readUInt32LE(12)
      cursor += FRAME_HEADER_SIZE

      if (
        chunkSize > datagram.length - cursor ||
        frameSize === 0 ||
        frameSize > MAX_FRAME_SIZE ||
        offset + chunkSize > frameSize
      ) {
        return
      }

      if (type === JPEG_FRAME_TYPE) {
        this.consumeChunk(
          sequence,
          frameSize,
          offset,
          Buffer.from(datagram.subarray(cursor, cursor + chunkSize))
        )
      }
      cursor += chunkSize
    }
  }

  private consumeChunk(sequence: number, frameSize: number, offset: number, chunk: Buffer): void {
    let assembly = this.assemblies.get(sequence)
    if (!assembly || assembly.frameSize !== frameSize) {
      assembly = { frameSize, chunks: new Map() }
      this.assemblies.set(sequence, assembly)
    }
    if (!assembly.chunks.has(offset)) assembly.chunks.set(offset, chunk)

    const ordered = [...assembly.chunks.entries()].sort(([a], [b]) => a - b)
    let expectedOffset = 0
    for (const [chunkOffset, bytes] of ordered) {
      if (chunkOffset !== expectedOffset) {
        this.trimAssemblies()
        return
      }
      expectedOffset += bytes.length
    }

    if (expectedOffset === frameSize) {
      this.assemblies.delete(sequence)
      this.queueFrame(
        Buffer.concat(
          ordered.map(([, bytes]) => bytes),
          frameSize
        )
      )
    }
    this.trimAssemblies()
  }

  private trimAssemblies(): void {
    while (this.assemblies.size > MAX_ASSEMBLIES) {
      const oldest = this.assemblies.keys().next().value
      if (oldest == null) return
      this.assemblies.delete(oldest)
    }
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
