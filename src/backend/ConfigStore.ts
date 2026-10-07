import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DEFAULT_CONFIG } from '../main/carplay/messages'
import {
  CAMERA_RESOLUTIONS,
  type CameraResolution,
  type ExtraConfig,
  type KeyBindings
} from '../main/Globals'

const DEFAULT_BINDINGS: KeyBindings = {
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  selectUp: 'KeyB',
  selectDown: 'Space',
  back: 'Backspace',
  home: 'KeyH',
  play: 'KeyP',
  pause: 'KeyO',
  next: 'KeyM',
  prev: 'KeyN'
}

export class ConfigStore {
  private config: ExtraConfig

  constructor(private readonly path: string) {
    this.config = this.read()
    this.write(this.config)
  }

  get(): ExtraConfig {
    return structuredClone(this.config)
  }

  save(next: ExtraConfig): ExtraConfig {
    this.config = normalizeConfig(next)
    this.write(this.config)
    return this.get()
  }

  private read(): ExtraConfig {
    let stored: Partial<ExtraConfig> & LegacyCameraConfig = {}
    if (existsSync(this.path)) {
      try {
        stored = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<ExtraConfig>
      } catch (error) {
        console.warn('[Backend] Ignoring invalid config file', error)
      }
    }
    return normalizeConfig(stored)
  }

  private write(config: ExtraConfig): void {
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, JSON.stringify(config, null, 2))
  }
}

type LegacyCameraConfig = {
  wifiCameraRotation?: unknown
  wifiCameraFrameSize?: unknown
  wifiCameraHorizontalFlip?: unknown
  wifiCameraVerticalFlip?: unknown
  wifiCameraHost?: unknown
  wifiCameraJpegQuality?: unknown
}

function normalizeConfig(value: Partial<ExtraConfig> & LegacyCameraConfig): ExtraConfig {
  const {
    wifiCameraRotation,
    wifiCameraFrameSize,
    wifiCameraHorizontalFlip,
    wifiCameraVerticalFlip,
    wifiCameraHost: _wifiCameraHost,
    wifiCameraJpegQuality: _wifiCameraJpegQuality,
    ...current
  } = value
  const merged = {
    ...DEFAULT_CONFIG,
    kiosk: true,
    camera: '',
    backgroundColor: '#000000',
    cameraRotation: normalizeRotation(wifiCameraRotation),
    cameraResolution: migrateLegacyResolution(wifiCameraFrameSize),
    cameraHorizontalFlip: wifiCameraHorizontalFlip === true,
    cameraVerticalFlip: wifiCameraVerticalFlip === true,
    gpsSmoothing: 0.55,
    nightMode: true,
    ...current,
    bindings: { ...DEFAULT_BINDINGS, ...(current.bindings ?? {}) }
  } as ExtraConfig

  merged.width = finiteNumber(merged.width, 800)
  merged.height = finiteNumber(merged.height, 480)
  merged.fps = finiteNumber(merged.fps, 60)
  merged.dpi = finiteNumber(merged.dpi, 160)
  merged.backgroundColor = /^#[0-9a-f]{6}$/i.test(merged.backgroundColor)
    ? merged.backgroundColor
    : '#000000'
  merged.cameraRotation = normalizeRotation(merged.cameraRotation)
  merged.cameraResolution = normalizeResolution(merged.cameraResolution)
  merged.cameraHorizontalFlip = merged.cameraHorizontalFlip === true
  merged.cameraVerticalFlip = merged.cameraVerticalFlip === true
  merged.gpsSmoothing = Math.min(0.9, Math.max(0, finiteNumber(merged.gpsSmoothing, 0.55)))
  // This runtime is a CarPlay display/controller only. Persist the direct
  // phone-to-car audio route even when migrating an older saved config.
  merged.audioTransferMode = true
  delete (merged as unknown as Record<string, unknown>).audioVolume
  delete (merged as unknown as Record<string, unknown>).navVolume
  delete (merged as unknown as Record<string, unknown>).outputGain
  delete (merged as unknown as Record<string, unknown>).microphone
  delete (merged as unknown as Record<string, unknown>).micType
  return merged
}

function finiteNumber(value: unknown, fallback: number): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function normalizeRotation(value: unknown): number {
  return ((finiteNumber(value, 0) % 360) + 360) % 360
}

function normalizeResolution(value: unknown): CameraResolution {
  const resolution = String(value ?? '') as CameraResolution
  return CAMERA_RESOLUTIONS.some(option => option.value === resolution) ? resolution : '1280x720'
}

function migrateLegacyResolution(value: unknown): CameraResolution {
  return ({
    11: '1280x720',
    10: '1024x768',
    9: '800x600',
    8: '640x480',
    5: '320x240'
  } as Record<number, CameraResolution>)[Number(value)] ?? '1280x720'
}
