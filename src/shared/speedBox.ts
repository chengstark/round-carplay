export type PixelImage = { width: number; height: number; data: Uint8ClampedArray }
export type PixelRect = { x: number; y: number; width: number; height: number }
export type SpeedBox = { limit: PixelRect | null; current: PixelRect; unit: PixelRect }

/** Locate a neutral white sign or a tall black speed readout, excluding colored map labels. */
export function findSpeedBox(image: PixelImage): SpeedBox | null {
  const { width, height, data } = image
  function components(light: boolean): Array<PixelRect & { area: number }> {
    const mask = new Uint8Array(width * height)
    for (let i = 0; i < mask.length; i++) {
      const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2]
      const lo = Math.min(r, g, b), hi = Math.max(r, g, b)
      mask[i] = (light ? lo > 170 && hi - lo < 55 : hi < 55 && hi - lo < 30) ? 1 : 0
    }
    const queue = new Int32Array(mask.length)
    const found: Array<PixelRect & { area: number }> = []
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue
      let head = 0, tail = 1, x0 = width, x1 = 0, y0 = height, y1 = 0
      queue[0] = i
      mask[i] = 0
      while (head < tail) {
        const p = queue[head++], x = p % width, y = Math.floor(p / width)
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y)
        if (x > 0 && mask[p - 1]) { mask[p - 1] = 0; queue[tail++] = p - 1 }
        if (x < width - 1 && mask[p + 1]) { mask[p + 1] = 0; queue[tail++] = p + 1 }
        if (y > 0 && mask[p - width]) { mask[p - width] = 0; queue[tail++] = p - width }
        if (y < height - 1 && mask[p + width]) { mask[p + width] = 0; queue[tail++] = p + width }
      }
      const w = x1 - x0 + 1, h = y1 - y0 + 1
      if (w >= width * .12 && h >= height * .08 && w <= width * .65 && h <= height * .5 && tail / (w * h) > .4) {
        found.push({ x: x0, y: y0, width: w, height: h, area: tail })
      }
    }
    return found.sort((a, b) => b.area - a.area)
  }
  const patch = (r: PixelRect, x: number, y: number, w: number, h: number): PixelRect => ({
    x: r.x + x * r.width, y: r.y + y * r.height, width: w * r.width, height: h * r.height,
  })
  const sign = components(true).find(r => r.width / r.height > .5 && r.width / r.height < 1.4 &&
    r.x + r.width < width * .8 && r.x + r.width * 2.05 < width)
  if (sign) return {
    limit: patch(sign, .1, .12, .8, .76),
    current: patch(sign, 1.1, .05, .92, .52),
    unit: patch(sign, 1.1, .62, .92, .36),
  }
  const readout = components(false).find(r => r.x + r.width / 2 > width * .65 &&
    r.height / r.width > 1.12 && r.height / r.width < 2.4)
  return readout ? { limit: null, current: patch(readout, .1, .08, .8, .48), unit: patch(readout, .1, .62, .8, .3) } : null
}
