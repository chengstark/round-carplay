import { WebUSBDevice } from 'usb'
import {
  Plugged,
  Unplugged,
  VideoData,
  AudioData,
  MediaData,
  MediaType,
  Command,
  SendCommand,
  SendTouch,
  DongleDriver,
  DongleConfig,
  DEFAULT_CONFIG
} from './messages'
import fs from 'fs'
import path from 'path'
import os from 'os'
import usb from 'usb'
import { NULL_EVENT_SINK, type ServiceEventSink } from '../events/ServiceEventSink'

let dongleConnected = false

interface PersistedMediaPayload {
  type: MediaType
  media?: Record<string, any>
  base64Image?: string
}

type PersistedMediaFile = {
  timestamp: string
  payload: PersistedMediaPayload
}

function readMediaFile(filePath: string): PersistedMediaFile {
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    return JSON.parse(raw) as PersistedMediaFile
  } catch {
    return {
      timestamp: '',
      payload: { type: MediaType.Data, media: {}, base64Image: undefined }
    }
  }
}

export class CarplayService {
  private driver = new DongleDriver()
  private config: DongleConfig = DEFAULT_CONFIG
  private pairTimeout: NodeJS.Timeout | null = null
  private frameInterval: NodeJS.Timeout | null = null
  private startPromise: Promise<void> | null = null
  private started = false
  private stopping = false
  private shuttingDown = false
  private videoFrameCount = 0
  private videoWidth = 0
  private videoHeight = 0

  constructor(
    private readonly events: ServiceEventSink = NULL_EVENT_SINK,
    private readonly dataDirectory = path.join(os.homedir(), '.config', 'round-carplay')
  ) {
    this.driver.on('message', (msg) => {
      if (msg instanceof Plugged) {
        console.log('[CarplayService] Phone connected through AutoKit')
        this.clearTimeouts()
        const frameRefreshMs = this.config.phoneConfig?.[msg.phoneType]?.frameInterval
        if (frameRefreshMs) {
          console.log(`[CarplayService] Requesting a refresh frame every ${frameRefreshMs}ms`)
          this.frameInterval = setInterval(() => {
            void this.driver.send(new SendCommand('frame'))
          }, frameRefreshMs)
        }
        this.events.send('carplay-event', { type: 'plugged' })

        if (!this.started) {
          console.log('[CarplayService] Auto-starting CarPlay after Plugged event')
          this.start().catch(console.error)
        }
      } else if (msg instanceof Unplugged) {
        console.log('[CarplayService] Phone disconnected from AutoKit')
        this.events.send('carplay-event', { type: 'unplugged' })
        this.stop().catch(console.error)
      } else if (msg instanceof VideoData) {
        this.videoFrameCount++
        if (this.videoFrameCount === 1 || this.videoFrameCount % 300 === 0) {
          console.log(
            `[CarplayService] Video frame ${this.videoFrameCount}: ${msg.width}x${msg.height}, ${msg.data.byteLength} bytes`
          )
        }
        if (msg.width !== this.videoWidth || msg.height !== this.videoHeight) {
          this.videoWidth = msg.width
          this.videoHeight = msg.height
          this.events.send('carplay-event', {
            type: 'resolution',
            payload: { width: msg.width, height: msg.height }
          })
        }
        // VideoData.data is a view beginning after AutoKit's 20-byte frame
        // header. Preserve that header for the renderer while excluding any
        // unrelated bytes that may surround a Node Buffer view.
        const packetStart = Math.max(0, msg.data.byteOffset - 20)
        const packetEnd = msg.data.byteOffset + msg.data.byteLength
        const packet = (msg.data.buffer as ArrayBuffer).slice(packetStart, packetEnd)
        this.sendChunked('carplay-video-chunk', packet, 512 * 1024)
      } else if (msg instanceof AudioData) {
        // Display-only mode deliberately discards any PCM or microphone
        // commands a dongle may still emit. Audio belongs to the phone's
        // direct Bluetooth connection to the car.
        return
      } else if (msg instanceof MediaData) {
        this.events.send('carplay-event', { type: 'media', payload: msg })
        fs.mkdirSync(this.dataDirectory, { recursive: true })
        const file = path.join(this.dataDirectory, 'mediaData.json')
        const existing = readMediaFile(file)
        const existingPayload = existing.payload
        const newPayload: PersistedMediaPayload = {
          type: msg.payload!.type
        }
        if (msg.payload!.type === MediaType.Data && msg.payload!.media) {
          newPayload.media = {
            ...existingPayload.media,
            ...msg.payload!.media
          }
          if (existingPayload.base64Image) {
            newPayload.base64Image = existingPayload.base64Image
          }
        } else if (msg.payload!.type === MediaType.AlbumCover && msg.payload!.base64Image) {
          newPayload.base64Image = msg.payload!.base64Image
          if (existingPayload.media) {
            newPayload.media = existingPayload.media
          }
        } else {
          newPayload.media = existingPayload.media
          newPayload.base64Image = existingPayload.base64Image
        }
        const out = {
          timestamp: new Date().toISOString(),
          payload: newPayload
        }
        fs.writeFileSync(file, JSON.stringify(out, null, 2), 'utf8')
      } else if (msg instanceof Command) {
        this.events.send('carplay-event', { type: 'command', message: msg })
      }
    })

    this.driver.on('failure', () => {
      this.events.send('carplay-event', { type: 'failure' })
    })
  }

  public markDongleConnected(connected: boolean) {
    dongleConnected = connected
  }

  public async autoStartIfNeeded() {
    if (this.shuttingDown) {
      console.log('[CarplayService] Skipping autoStartIfNeeded – shutting down')
      return
    }
    if (!this.started && dongleConnected) {
      console.log('[CarplayService] AutoStartIfNeeded → calling start()')
      await this.start()
    }
  }

  public async start(): Promise<void> {
    if (this.started) return
    if (this.startPromise) return this.startPromise

    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  private async startInternal(): Promise<void> {
    try {
      const configPath = path.join(this.dataDirectory, 'config.json')
      const userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'))
      this.config = { ...this.config, ...userConfig, audioTransferMode: true }
    } catch {
      // fallback to DEFAULT_CONFIG
    }

    console.debug('[CarplayService] display-only mode: phone handles audio directly')

    const device = usb
      .getDeviceList()
      .find(
        (d) =>
          d.deviceDescriptor.idVendor === 0x1314 &&
          [0x1520, 0x1521].includes(d.deviceDescriptor.idProduct)
      )
    if (!device) {
      console.warn('[CarplayService] No dongle found during start()')
      return
    }

    try {
      const webUsbDevice = await WebUSBDevice.createInstance(device)
      await webUsbDevice.open()
      await this.driver.initialise(webUsbDevice)
      await this.driver.start(this.config)
      this.pairTimeout = setTimeout(() => {
        this.driver.send(new SendCommand('wifiPair'))
      }, 15000)
      this.started = true
      this.videoFrameCount = 0
      this.videoWidth = 0
      this.videoHeight = 0
      console.log('[CarplayService] CarPlay started')
    } catch (err) {
      console.error('[CarplayService] Error during start()', err)
    }
  }

  public async stop(): Promise<void> {
    if (this.stopping) return
    if (this.startPromise) await this.startPromise
    if (!this.started) return
    this.stopping = true
    this.clearTimeouts()
    try {
      await this.driver.close()
    } catch (err) {
      console.warn('[CarplayService] driver.close() failed', err)
    }
    this.started = false
    this.videoFrameCount = 0
    this.videoWidth = 0
    this.videoHeight = 0
    this.stopping = false
    console.log('[CarplayService] CarPlay stopped')
  }

  public sendFrame(): void {
    this.driver.send(new SendCommand('frame'))
  }

  public sendTouch(x: number, y: number, action: number): void {
    this.driver.send(new SendTouch(x, y, action))
  }

  public sendKeyCommand(command: string): void {
    this.driver.send(new SendCommand(command as ConstructorParameters<typeof SendCommand>[0]))
  }

  public prepareForShutdown(): void {
    this.shuttingDown = true
  }

  private clearTimeouts() {
    if (this.pairTimeout) {
      clearTimeout(this.pairTimeout)
      this.pairTimeout = null
    }
    if (this.frameInterval) {
      clearInterval(this.frameInterval)
      this.frameInterval = null
    }
  }

  private sendChunked(
    channel: string,
    data?: ArrayBuffer,
    chunkSize = 512 * 1024,
    extra: Record<string, any> = {}
  ) {
    if (!data) return
    let offset = 0
    const total = data.byteLength
    const id = Math.random().toString(36).slice(2)

    while (offset < total) {
      const end = Math.min(offset + chunkSize, total)
      const chunk = data.slice(offset, end)
      this.events.send(channel, {
        id,
        offset,
        total,
        isLast: end >= total,
        chunk: Buffer.from(chunk),
        ...extra
      })
      offset = end
    }
  }
}
