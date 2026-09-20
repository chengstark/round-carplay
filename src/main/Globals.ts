import { DongleConfig } from '@carplay/messages'

export type ExtraConfig = DongleConfig & {
  kiosk: boolean,
  camera: string,
  backgroundColor: string,
  wifiCameraRotation: WifiCameraRotation,
  wifiCameraHost: string,
  wifiCameraFrameSize: WifiCameraFrameSize,
  wifiCameraJpegQuality: number,
  wifiCameraHorizontalFlip: boolean,
  gpsSmoothing: number,
  microphone: string,
  bindings: KeyBindings,
  audioVolume: number;
  navVolume: number;
  outputGain: number;
}

/** Clockwise camera rotation in degrees, normalized to the range 0–359. */
export type WifiCameraRotation = number

/** ESP32 camera frame-size values accepted by the XIAO `/control` endpoint. */
export type WifiCameraFrameSize = 5 | 8 | 9 | 10 | 11

export const WIFI_CAMERA_RESOLUTIONS: ReadonlyArray<{
  value: WifiCameraFrameSize
  label: string
  width: number
  height: number
}> = [
  { value: 11, label: 'HD 1280×720', width: 1280, height: 720 },
  { value: 10, label: 'XGA 1024×768', width: 1024, height: 768 },
  { value: 9, label: 'SVGA 800×600', width: 800, height: 600 },
  { value: 8, label: 'VGA 640×480', width: 640, height: 480 },
  { value: 5, label: 'QVGA 320×240', width: 320, height: 240 }
]

export type WifiCameraOptions = {
  host: string
  frameSize: WifiCameraFrameSize
  jpegQuality: number
  horizontalFlip: boolean
}

export interface KeyBindings {
  'selectUp': string,
  'selectDown': string,
  'up': string,
  'left': string,
  'right': string,
  'down': string,
  'back': string,
  'home': string,
  'play': string,
  'pause': string,
  'next': string,
  'prev': string
}

export interface CanMessage {
  canId: number,
  byte: number,
  mask: number
}

export interface CanConfig {
  reverse?: CanMessage,
  lights?: CanMessage
}
