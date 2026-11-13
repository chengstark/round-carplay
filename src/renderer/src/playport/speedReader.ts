import { EMPTY_SPEED, SPEED_CROP, StableSpeedReading, parseSpeedTiles, type SpeedOcrWord, type SpeedReading } from '../../../shared/speedOcr'
import { findSpeedBox } from '../../../shared/speedBox'

/** Small in-memory main-stream crop, one request/second, one request in flight. */
export class SpeedReader {
  private readonly crop = document.createElement('canvas')
  private readonly tiles = document.createElement('canvas')
  private readonly tile = document.createElement('canvas')
  private readonly stable = new StableSpeedReading()
  private pending: AbortController | null = null
  private nextRead = 0
  private lastRead = 0
  private generation = 0
  private signature = ''
  private readonly expiry = window.setInterval(() => {
    if (!this.enabled() || (this.lastRead > 0 && performance.now() - this.lastRead > 3000)) this.reset()
  }, 500)

  constructor(private readonly enabled: () => boolean, private readonly publish: (reading: SpeedReading) => void) {}

  frame(frame: VideoFrame): void {
    if (!this.enabled()) { this.reset(); return }
    const now = performance.now()
    if (this.pending || now < this.nextRead) return
    this.nextRead = now + 1000
    const controller = new AbortController()
    this.pending = controller
    const generation = this.generation
    const width = Math.round(frame.displayWidth * SPEED_CROP.width)
    const height = Math.round(frame.displayHeight * SPEED_CROP.height)
    this.crop.width = width
    this.crop.height = height
    const context = this.crop.getContext('2d', { willReadFrequently: true })
    if (!context) { this.pending = null; return }
    context.drawImage(frame, frame.displayWidth * SPEED_CROP.x, frame.displayHeight * SPEED_CROP.y,
      frame.displayWidth * SPEED_CROP.width, frame.displayHeight * SPEED_CROP.height, 0, 0, width, height)
    const pixels = context.getImageData(0, 0, width, height)
    const box = findSpeedBox(pixels)
    if (!box) { this.reset(); return }
    this.tiles.width = 480
    this.tiles.height = 120
    const sheet = this.tiles.getContext('2d')!
    sheet.fillStyle = '#fff'
    sheet.fillRect(0, 0, 480, 120)
    for (const [index, rect] of [box.limit, box.current, box.unit].entries()) {
      if (!rect) continue
      this.tile.width = Math.max(1, Math.ceil(rect.width * 3))
      this.tile.height = Math.max(1, Math.ceil(rect.height * 3))
      const tile = this.tile.getContext('2d', { willReadFrequently: true })!
      tile.drawImage(this.crop, rect.x, rect.y, rect.width, rect.height, 0, 0, this.tile.width, this.tile.height)
      const normalized = tile.getImageData(0, 0, this.tile.width, this.tile.height)
      for (let i = 0; i < normalized.data.length; i += 4) {
        let gray = Math.round(normalized.data[i] * .2126 + normalized.data[i + 1] * .7152 + normalized.data[i + 2] * .0722)
        if (index > 0) gray = 255 - gray
        normalized.data[i] = normalized.data[i + 1] = normalized.data[i + 2] = gray
        normalized.data[i + 3] = 255
      }
      tile.putImageData(normalized, 0, 0)
      const scale = Math.min(120 / this.tile.width, 90 / this.tile.height)
      const w = this.tile.width * scale, h = this.tile.height * scale
      sheet.drawImage(this.tile, 0, 0, this.tile.width, this.tile.height, index * 160 + (160 - w) / 2, (120 - h) / 2, w, h)
    }
    this.tiles.toBlob(blob => {
      if (!blob || generation !== this.generation) { if (this.pending === controller) this.pending = null; return }
      const timeout = window.setTimeout(() => controller.abort(), 3500)
      void fetch('/api/speed-ocr', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: blob, signal: controller.signal })
        .then(async response => {
          if (!response.ok) throw new Error('OCR unavailable')
          return response.json() as Promise<{ words: SpeedOcrWord[] }>
        })
        .then(result => {
          if (generation !== this.generation || !this.enabled()) return
          const reading = parseSpeedTiles(result.words, box.limit !== null)
          this.lastRead = performance.now()
          this.update(this.stable.accept(reading))
        })
        .catch(() => { if (generation === this.generation) this.reset() })
        .finally(() => {
          window.clearTimeout(timeout)
          if (this.pending === controller) this.pending = null
        })
    }, 'image/png')
  }

  reset(): void {
    this.generation++
    this.pending?.abort()
    this.pending = null
    this.lastRead = 0
    this.stable.reset()
    this.update({ ...EMPTY_SPEED })
  }
  close(): void { window.clearInterval(this.expiry); this.reset() }
  private update(reading: SpeedReading): void {
    const signature = JSON.stringify(reading)
    if (signature === this.signature) return
    this.signature = signature
    this.publish(reading)
  }
}
