import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DEFAULT_CONFIG } from '../main/carplay/messages'
import type { ExtraConfig, KeyBindings, WifiCameraFrameSize } from '../main/Globals'

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
    let stored: Partial<ExtraConfig> = {}
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

function normalizeConfig(value: Partial<ExtraConfig>): ExtraConfig {
  const merged = {
    ...DEFAULT_CONFIG,
    kiosk: true,
    camera: '',
    backgroundColor: '#000000',
    wifiCameraRotation: 0,
    wifiCameraHost: '192.168.4.1',
    wifiCameraFrameSize: 11,
    wifiCameraJpegQuality: 20,
    wifiCameraHorizontalFlip: false,
    gpsSmoothing: 0.55,
    microphone: '',
    nightMode: true,
    audioVolume: 1,
    navVolume: 0.5,
    ...value,
    bindings: { ...DEFAULT_BINDINGS, ...(value.bindings ?? {}) }
  } as ExtraConfig

  merged.width = finiteNumber(merged.width, 800)
  merged.height = finiteNumber(merged.height, 480)
  merged.fps = finiteNumber(merged.fps, 60)
  merged.dpi = finiteNumber(merged.dpi, 160)
  merged.backgroundColor = /^#[0-9a-f]{6}$/i.test(merged.backgroundColor)
    ? merged.backgroundColor
    : '#000000'
  merged.wifiCameraRotation = ((finiteNumber(merged.wifiCameraRotation, 0) % 360) + 360) % 360
  merged.wifiCameraHost = normalizeHost(merged.wifiCameraHost)
  merged.wifiCameraFrameSize = normalizeFrameSize(merged.wifiCameraFrameSize)
  merged.wifiCameraJpegQuality = Math.min(
    63,
    Math.max(4, Math.round(finiteNumber(merged.wifiCameraJpegQuality, 20)))
  )
  merged.wifiCameraHorizontalFlip = merged.wifiCameraHorizontalFlip === true
  merged.gpsSmoothing = Math.min(0.9, Math.max(0, finiteNumber(merged.gpsSmoothing, 0.55)))
  return merged
}

function finiteNumber(value: unknown, fallback: number): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function normalizeHost(value: unknown): string {
  const candidate = String(value ?? '').trim()
  if (!candidate) return '192.168.4.1'
  try {
    return new URL(candidate.includes('://') ? candidate : `http://${candidate}`).hostname
  } catch {
    return '192.168.4.1'
  }
}

function normalizeFrameSize(value: unknown): WifiCameraFrameSize {
  const frameSize = Number(value)
  return [5, 8, 9, 10, 11].includes(frameSize) ? (frameSize as WifiCameraFrameSize) : 11
}
