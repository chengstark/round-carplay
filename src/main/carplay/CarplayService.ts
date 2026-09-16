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
  SendAudio,
  DongleDriver,
  DongleConfig,
  DEFAULT_CONFIG,
  decodeTypeMap,
  AudioCommand
} from './messages'
import fs from 'fs'
import path from 'path'
import os from 'os'
import usb from 'usb'
import NodeMicrophone from './node/NodeMicrophone'
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
  private _mic: NodeMicrophone | null = null
  private started = false
  private stopping = false
  private shuttingDown = false
  private audioInfoSent = false

  constructor(
    private readonly events: ServiceEventSink = NULL_EVENT_SINK,
    private readonly dataDirectory = path.join(os.homedir(), '.config', 'round-carplay')
  ) {
    this.driver.on('message', (msg) => {
      if (msg instanceof Plugged) {
        this.clearTimeouts()
        this.events.send('carplay-event', { type: 'plugged' })

        if (!this.started) {
          console.log('[CarplayService] Auto-starting CarPlay after Plugged event')
          this.start().catch(console.error)
        }
      } else if (msg instanceof Unplugged) {
        this.events.send('carplay-event', { type: 'unplugged' })
        this.stop().catch(console.error)
      } else if (msg instanceof VideoData) {
        this.events.send('carplay-event', {
          type: 'resolution',
          payload: { width: msg.width, height: msg.height }
        })
        this.sendChunked('carplay-video-chunk', msg.data?.buffer as ArrayBuffer, 512 * 1024)
      } else if (msg instanceof AudioData) {
        if (msg.data) {
          this.sendChunked('carplay-audio-chunk', msg.data.buffer as ArrayBuffer, 64 * 1024, {
            ...msg
          })
          if (!this.audioInfoSent) {
            const meta = decodeTypeMap[msg.decodeType]
            if (meta) {
              this.events.send('carplay-event', {
                type: 'audioInfo',
                payload: {
                  codec: meta.format ?? meta.mimeType,
                  sampleRate: meta.frequency,
                  channels: meta.channel,
                  bitDepth: meta.bitDepth
                }
              })
              this.audioInfoSent = true
            }
          }
        } else if (msg.command != null) {
          console.debug('[CarplayService] Received audio command:', msg.command)
          if (
            msg.command === AudioCommand.AudioSiriStart ||
            msg.command === AudioCommand.AudioPhonecallStart
          ) {
            if (this.config.audioTransferMode) {
              console.debug(
                '[CarplayService] Skipping microphone start because audioTransferMode is enabled'
              )
              return
            }
            if (!this._mic) {
              console.debug('[CarplayService] Initializing microphone')
              this._mic = new NodeMicrophone()
              this._mic.on('data', (data: Buffer) => {
                this.driver.send(new SendAudio(new Int16Array(data.buffer)))
              })
            }
            this._mic.start()
          } else if (
            msg.command === AudioCommand.AudioSiriStop ||
            msg.command === AudioCommand.AudioPhonecallStop
          ) {
            this._mic?.stop()
          }
        }
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
    try {
      const configPath = path.join(this.dataDirectory, 'config.json')
      const userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'))
      this.config = { ...this.config, ...userConfig }
    } catch {
      // fallback to DEFAULT_CONFIG
    }

    console.debug('[CarplayService] audioTransferMode:', this.config.audioTransferMode)

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
      this.audioInfoSent = false
      console.log('[CarplayService] CarPlay started')
    } catch (err) {
      console.error('[CarplayService] Error during start()', err)
    }
  }

  public async stop(): Promise<void> {
    if (!this.started || this.stopping) return
    this.stopping = true
    this.clearTimeouts()
    try {
      await this.driver.close()
    } catch (err) {
      console.warn('[CarplayService] driver.close() failed', err)
    }
    try {
      this._mic?.stop()
    } catch (err) {
      console.warn('[CarplayService] mic.stop() failed', err)
    }
    this.started = false
    this.audioInfoSent = false
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
    if (this.pairTimeout) clearTimeout(this.pairTimeout)
    if (this.frameInterval) clearInterval(this.frameInterval)
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
