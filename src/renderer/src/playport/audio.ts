import { AudioCodec, type AudioConfigMessage, type AudioPacketMessage } from './protocol'

type StreamState = {
  codec: number
  sampleRate: number
  channels: number
  decoder: AudioDecoder | null
  gain: GainNode
  nextPlayTime: number
}

/** Browser audio mixer for PlayPort media, guidance, speech and call streams. */
export class PlayPortAudio {
  private readonly context = new AudioContext({ latencyHint: 'interactive' })
  private readonly master = this.context.createGain()
  private readonly streams = new Map<number, StreamState>()

  constructor(private readonly onError: (message: string) => void) {
    this.master.connect(this.context.destination)
  }

  async unlock(): Promise<void> {
    if (this.context.state !== 'running') await this.context.resume()
  }

  configure(message: AudioConfigMessage): void {
    this.stop(message.streamType)
    const gain = this.context.createGain()
    gain.connect(this.master)
    const state: StreamState = {
      codec: message.codec,
      sampleRate: message.sampleRate,
      channels: Math.max(1, message.channels),
      decoder: null,
      gain,
      nextPlayTime: 0
    }

    if (message.codec === AudioCodec.AacLc || message.codec === AudioCodec.Opus) {
      if (typeof AudioDecoder === 'undefined') {
        this.onError('This Chromium build does not expose WebCodecs AudioDecoder.')
      } else {
        try {
          const decoder = new AudioDecoder({
            output: (data) => {
              try { this.playAudioData(state, data) } finally { data.close() }
            },
            error: (error) => this.onError(error.message)
          })
          decoder.configure(message.codec === AudioCodec.AacLc ? {
            codec: 'mp4a.40.2',
            sampleRate: message.sampleRate,
            numberOfChannels: state.channels,
            description: message.description.length ? message.description : undefined
          } : {
            codec: 'opus',
            sampleRate: message.sampleRate,
            numberOfChannels: state.channels
          })
          state.decoder = decoder
        } catch (error) {
          this.onError(error instanceof Error ? error.message : String(error))
        }
      }
    }
    this.streams.set(message.streamType, state)
  }

  push(message: AudioPacketMessage): void {
    const state = this.streams.get(message.streamType)
    if (!state) return
    if (state.decoder) {
      try {
        state.decoder.decode(new EncodedAudioChunk({
          type: 'key',
          timestamp: message.timestampUs,
          data: message.data
        }))
      } catch (error) {
        this.onError(error instanceof Error ? error.message : String(error))
      }
    } else if (state.codec === AudioCodec.Lpcm) {
      this.playPcm(state, message.data)
    }
  }

  stop(streamType: number): void {
    const state = this.streams.get(streamType)
    if (!state) return
    this.streams.delete(streamType)
    try { state.gain.disconnect() } catch {}
    try { state.decoder?.close() } catch {}
  }

  close(): void {
    for (const streamType of [...this.streams.keys()]) this.stop(streamType)
    void this.context.close()
  }

  private playAudioData(state: StreamState, data: AudioData): void {
    if (this.context.state !== 'running') return
    const buffer = this.context.createBuffer(data.numberOfChannels, data.numberOfFrames, data.sampleRate)
    for (let channel = 0; channel < data.numberOfChannels; channel += 1) {
      const plane = new Float32Array(data.numberOfFrames)
      data.copyTo(plane, { planeIndex: channel, format: 'f32-planar' })
      buffer.copyToChannel(plane, channel)
    }
    this.schedule(state, buffer)
  }

  private playPcm(state: StreamState, payload: Uint8Array): void {
    if (this.context.state !== 'running' || payload.length < 2) return
    const frames = Math.max(1, Math.floor(payload.length / 2 / state.channels))
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
    const buffer = this.context.createBuffer(state.channels, frames, state.sampleRate)
    for (let channel = 0; channel < state.channels; channel += 1) {
      const plane = new Float32Array(frames)
      for (let frame = 0; frame < frames; frame += 1) {
        plane[frame] = view.getInt16((frame * state.channels + channel) * 2, true) / 32768
      }
      buffer.copyToChannel(plane, channel)
    }
    this.schedule(state, buffer)
  }

  private schedule(state: StreamState, buffer: AudioBuffer): void {
    const now = this.context.currentTime
    if (state.nextPlayTime < now + 0.1 || state.nextPlayTime > now + 0.35) {
      state.nextPlayTime = now + 0.1
    }
    const source = this.context.createBufferSource()
    source.buffer = buffer
    source.connect(state.gain)
    source.start(state.nextPlayTime)
    state.nextPlayTime += buffer.duration
  }
}
