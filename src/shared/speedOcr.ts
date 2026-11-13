export type SpeedUnit = 'mph' | 'km/h'
export type SpeedOcrWord = { text: string; confidence: number; x: number; y: number; width: number; height: number }
export type SpeedReading = { limit: number | null; current: number | null; unit: SpeedUnit | null }
export const EMPTY_SPEED: SpeedReading = { limit: null, current: null, unit: null }
// Main CarPlay's round-safe app window, upper right; includes both expanded and collapsed toolbars.
export const SPEED_CROP = { x: .62, y: .145, width: .25, height: .29 }

/** Three independently prepared tiles: limit, current speed, unit. Never infer a missing value. */
export function parseSpeedTiles(words: SpeedOcrWord[], hasLimit: boolean): SpeedReading {
  const trusted = words.filter(w => Number.isFinite(w.confidence) && w.confidence >= .8 &&
    [w.x, w.y, w.width, w.height].every(Number.isFinite) && w.width > 0 && w.height > 0)
  const center = (w: SpeedOcrWord) => w.x + w.width / 2
  const units = trusted.filter(w => center(w) > 2 / 3 && /^(mph|kph|kmh|km\s*\/\s*h)$/i.test(w.text.trim()))
  if (units.length !== 1) return { ...EMPTY_SPEED }
  const u = units[0]
  const unit: SpeedUnit = /^mph$/i.test(u.text.trim()) ? 'mph' : 'km/h'
  const numbers = trusted.filter(w => /^\d{1,3}$/.test(w.text))
  const limits = numbers.filter(w => hasLimit && center(w) < 1 / 3 && Number(w.text) >= 5 &&
    Number(w.text) <= (unit === 'mph' ? 100 : 160))
  const speeds = numbers.filter(w => center(w) >= 1 / 3 && center(w) < 2 / 3 &&
    Number(w.text) <= (unit === 'mph' ? 160 : 260))
  return {
    limit: limits.length === 1 ? Number(limits[0].text) : null,
    current: speeds.length === 1 ? Number(speeds[0].text) : null,
    unit,
  }
}

/** Values need two matching reads. Missing/changed values disappear immediately; no stale sign. */
export class StableSpeedReading {
  private previous: SpeedReading = { ...EMPTY_SPEED }
  accept(next: SpeedReading): SpeedReading {
    const result = {
      unit: next.unit,
      limit: next.unit === this.previous.unit && next.limit === this.previous.limit ? next.limit : null,
      current: next.unit === this.previous.unit && next.current === this.previous.current ? next.current : null,
    }
    this.previous = { ...next }
    return result
  }
  reset(): void { this.previous = { ...EMPTY_SPEED } }
}
