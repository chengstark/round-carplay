import { DongleConfig } from '@carplay/messages'

export type ExtraConfig = DongleConfig & {
  kiosk: boolean,
  camera: string,
  backgroundColor: string,
  cameraRotation: CameraRotation,
  cameraResolution: CameraResolution,
  cameraHorizontalFlip: boolean,
  cameraVerticalFlip: boolean,
  gpsSmoothing: number,
  bindings: KeyBindings,
}

/** Clockwise camera rotation in degrees, normalized to the range 0–359. */
export type CameraRotation = number

export type CameraResolution = '1280x720' | '1024x768' | '800x600' | '640x480' | '320x240'

export const CAMERA_RESOLUTIONS: ReadonlyArray<{
  value: CameraResolution
  label: string
  width: number
  height: number
}> = [
  { value: '1280x720', label: 'HD 1280×720', width: 1280, height: 720 },
  { value: '1024x768', label: 'XGA 1024×768', width: 1024, height: 768 },
  { value: '800x600', label: 'SVGA 800×600', width: 800, height: 600 },
  { value: '640x480', label: 'VGA 640×480', width: 640, height: 480 },
  { value: '320x240', label: 'QVGA 320×240', width: 320, height: 240 }
]

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
