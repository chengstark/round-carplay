export const WireType = {
  VideoConfig: 1,
  VideoFrame: 2,
  AudioConfig: 3,
  AudioPacket: 4,
  ScreenActive: 5,
  AudioStopped: 6
} as const

export const VideoCodec = { H264: 1, H265: 2 } as const
export const AudioCodec = { AacLc: 1, Opus: 2, Lpcm: 3 } as const

export type VideoConfigMessage = {
  kind: 'video-config'
  streamType: number
  codec: number
  width: number
  height: number
  codecData: Uint8Array
}

export type VideoFrameMessage = {
  kind: 'video-frame'
  streamType: number
  keyframe: boolean
  data: Uint8Array
}

export type AudioConfigMessage = {
  kind: 'audio-config'
  streamType: number
  codec: number
  sampleRate: number
  channels: number
  name: string
  description: Uint8Array
}

export type AudioPacketMessage = {
  kind: 'audio-packet'
  streamType: number
  timestampUs: number
  data: Uint8Array
}

export type WireMessage =
  | VideoConfigMessage
  | VideoFrameMessage
  | AudioConfigMessage
  | AudioPacketMessage
  | { kind: 'screen-active'; streamType: number; active: boolean }
  | { kind: 'audio-stopped'; streamType: number }

export type CarPlayApp = 'youtube-music' | 'phone'

export type ClientMessage =
  | { type: 'touch'; contacts: Array<{ id: number; x: number; y: number; down: boolean }> }
  | { type: 'media'; media: number }
  | { type: 'launchApp'; app: CarPlayApp }
  | { type: 'knob'; knob: { select: boolean; home: boolean; back: boolean; x: number; y: number; wheel: number } }
  | { type: 'night'; night: boolean }
  | { type: 'telephony'; telephony: number }
  | { type: 'keyframe' }
  | { type: 'ping' }

export type NowPlayingViewState = {
  title?: string
  artist?: string
  album?: string
  appName?: string
  durationMillis?: number
  elapsedMillis: number
  playback: 'stopped' | 'playing' | 'paused' | 'seeking_forward' | 'seeking_backward' | 'unknown'
  artworkTransferId?: number
  receivedAtEpochMillis: number
}

export type ManeuverViewState = {
  index?: number
  description?: string
  roadName?: string
  type?: number
  distanceMeters?: number
  distanceText?: string
  distanceUnit?: number
}

export type NavigationViewState = {
  active: boolean
  maneuverUpdate: boolean
  routeState: number
  currentRoad?: string
  destination?: string
  estimatedArrival?: number
  timeRemainingSeconds?: number
  distanceRemainingMeters?: number
  distanceRemainingText?: string
  distanceRemainingUnit?: number
  distanceToManeuverMeters?: number
  distanceToManeuverText?: string
  distanceToManeuverUnit?: number
  sourceName?: string
  maneuver?: ManeuverViewState
  updateSequence: number
}

export type VehicleUiSnapshot = {
  nowPlaying: NowPlayingViewState
  navigation: NavigationViewState
  phone: { active: boolean; status: string; updateSequence: number }
}

export type ServerMessage = {
  type: string
  deviceName?: string
  sessionActive?: boolean
  width?: number
  height?: number
  roundDisplay?: boolean
  message?: string
  vehicle?: VehicleUiSnapshot
}

export function parseWireMessage(buffer: ArrayBuffer): WireMessage | null {
  if (buffer.byteLength < 2) return null
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)
  switch (bytes[0]) {
    case WireType.VideoConfig:
      if (buffer.byteLength < 12) return null
      return {
        kind: 'video-config',
        streamType: bytes[1],
        codec: bytes[2],
        width: view.getUint32(3, true),
        height: view.getUint32(7, true),
        codecData: bytes.slice(11)
      }
    case WireType.VideoFrame:
      if (buffer.byteLength < 11) return null
      return {
        kind: 'video-frame',
        streamType: bytes[1],
        keyframe: (bytes[2] & 1) === 1,
        data: bytes.slice(11)
      }
    case WireType.AudioConfig: {
      if (buffer.byteLength < 9) return null
      const nameLength = bytes[8]
      const descriptionStart = 9 + nameLength
      return {
        kind: 'audio-config',
        streamType: bytes[1],
        codec: bytes[2],
        sampleRate: view.getUint32(3, true),
        channels: bytes[7],
        name: new TextDecoder().decode(bytes.slice(9, descriptionStart)),
        description: bytes.slice(descriptionStart)
      }
    }
    case WireType.AudioPacket:
      if (buffer.byteLength < 10) return null
      return {
        kind: 'audio-packet',
        streamType: bytes[1],
        timestampUs: Number(view.getBigUint64(2, true)),
        data: bytes.slice(10)
      }
    case WireType.ScreenActive:
      return { kind: 'screen-active', streamType: bytes[1], active: bytes[2] === 1 }
    case WireType.AudioStopped:
      return { kind: 'audio-stopped', streamType: bytes[1] }
    default:
      return null
  }
}

export function annexBToAvcc(data: Uint8Array): Uint8Array {
  const units: Array<{ offset: number; length: number }> = []
  let index = 0
  while (index + 3 < data.length) {
    let startLength = 0
    if (data[index] === 0 && data[index + 1] === 0 && data[index + 2] === 1) startLength = 3
    else if (
      index + 4 <= data.length && data[index] === 0 && data[index + 1] === 0 &&
      data[index + 2] === 0 && data[index + 3] === 1
    ) startLength = 4
    if (!startLength) {
      index += 1
      continue
    }
    const nalStart = index + startLength
    let nextStart = -1
    let scan = nalStart
    while (scan + 2 < data.length) {
      if (data[scan] === 0 && data[scan + 1] === 0 && (
        data[scan + 2] === 1 ||
        (scan + 3 < data.length && data[scan + 2] === 0 && data[scan + 3] === 1)
      )) {
        nextStart = scan
        break
      }
      scan += 1
    }
    const nalEnd = nextStart === -1 ? data.length : nextStart
    if (nalEnd > nalStart) units.push({ offset: nalStart, length: nalEnd - nalStart })
    index = nalEnd
  }
  if (!units.length) return data
  const output = new Uint8Array(units.reduce((total, unit) => total + 4 + unit.length, 0))
  const view = new DataView(output.buffer)
  let offset = 0
  for (const unit of units) {
    view.setUint32(offset, unit.length)
    output.set(data.subarray(unit.offset, unit.offset + unit.length), offset + 4)
    offset += 4 + unit.length
  }
  return output
}

export function avcCodecString(avcC: Uint8Array): string {
  if (avcC.length < 4) return 'avc1.42E01E'
  const hex = (value: number) => value.toString(16).padStart(2, '0')
  return `avc1.${hex(avcC[1])}${hex(avcC[2])}${hex(avcC[3])}`
}
